"""
EventSink: opt-out check, context enrichment, buffer management, timed flush.
"""

from __future__ import annotations

import asyncio
import locale
import os
import platform
import threading
from typing import Any

from kimi_cli.telemetry.transport import AsyncTransport
from kimi_cli.utils.logging import logger


class EventSink:
    """Buffers telemetry events and flushes them in batches."""

    FLUSH_INTERVAL_S = 30.0
    FLUSH_THRESHOLD = 50

    def __init__(
        self,
        transport: AsyncTransport,
        *,
        version: str = "",
        model: str = "",
        ui_mode: str = "shell",
    ) -> None:
        self._transport = transport
        self._buffer: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._flush_task: asyncio.Task[None] | None = None
        # Static context enrichment
        self._context: dict[str, Any] = {
            "version": version,
            "runtime": "python",
            "platform": platform.system().lower(),
            "arch": platform.machine(),
            "python_version": platform.python_version(),
            "os_version": platform.release(),
            "ci": bool(os.environ.get("CI")),
            "locale": locale.getlocale()[0] or "",
            "terminal": os.environ.get("TERM_PROGRAM", ""),
        }
        self._model = model
        self._ui_mode = ui_mode

    def accept(self, event: dict[str, Any]) -> None:
        """Accept an event into the buffer. Non-blocking, thread-safe."""
        # Enrich with static context (copy to avoid mutating the caller's dict)
        ctx = {**self._context, "ui_mode": self._ui_mode}
        if self._model:
            ctx["model"] = self._model
        enriched = {**event, "context": ctx}

        with self._lock:
            self._buffer.append(enriched)
            should_flush = len(self._buffer) >= self.FLUSH_THRESHOLD

        if should_flush:
            self._schedule_async_flush()

    def start_periodic_flush(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Start a background task that flushes every FLUSH_INTERVAL_S seconds."""
        if self._flush_task is not None:
            return

        async def _periodic() -> None:
            try:
                while True:
                    await asyncio.sleep(self.FLUSH_INTERVAL_S)
                    await self._flush_async()
            except asyncio.CancelledError:
                pass

        if loop is None:
            loop = asyncio.get_running_loop()
        self._flush_task = loop.create_task(_periodic())

    async def retry_disk_events(self) -> None:
        """Retry sending any events that were previously saved to disk."""
        await self._transport.retry_disk_events()

    def clear_buffer(self) -> None:
        """Discard all buffered events without sending them."""
        with self._lock:
            self._buffer.clear()

    def stop_periodic_flush(self) -> None:
        """Cancel the periodic flush task."""
        if self._flush_task is not None:
            self._flush_task.cancel()
            self._flush_task = None

    async def flush(self) -> None:
        """Async flush: send all buffered events."""
        await self._flush_async()

    def flush_sync(self) -> None:
        """Synchronous flush for atexit / signal handlers.

        Writes remaining events to disk fallback file so they can be
        retried on next startup. Does NOT attempt HTTP (no event loop).
        """
        with self._lock:
            if not self._buffer:
                return
            events = list(self._buffer)
            self._buffer.clear()

        try:
            self._transport.save_to_disk(events)
        except Exception:
            logger.debug("Failed to save telemetry events to disk on exit")

    async def _flush_async(self) -> None:
        """Take all buffered events and send them."""
        with self._lock:
            if not self._buffer:
                return
            events = list(self._buffer)
            self._buffer.clear()

        try:
            await self._transport.send(events)
        except Exception:
            # Transport handles disk fallback internally; log and move on
            logger.debug("Telemetry flush failed, events saved to disk for retry")

    def _schedule_async_flush(self) -> None:
        """Schedule an async flush from any thread."""
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._flush_async())
        except RuntimeError:
            # No running event loop — will be flushed by periodic task or on exit
            pass
