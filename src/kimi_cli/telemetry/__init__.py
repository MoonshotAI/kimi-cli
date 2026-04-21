"""
Telemetry event tracking for kimi-cli.

This module has NO dependencies on other kimi_cli modules to avoid import cycles.
track() can be called at any point during startup, even before the sink is attached.
Events are buffered in memory and flushed once the sink is ready.

Usage:
    from kimi_cli.telemetry import track, set_context, attach_sink

    # Early in startup — events queue in memory
    track("first_launch")

    # After app init — attach sink to start flushing
    set_context(device_id="abc", session_id="def")
    attach_sink(sink)
"""

from __future__ import annotations

import atexit
import time
import uuid
from collections import deque
from contextlib import suppress
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from kimi_cli.telemetry.sink import EventSink

# ---------------------------------------------------------------------------
# Module-level state (zero dependencies)
# ---------------------------------------------------------------------------

_MAX_QUEUE_SIZE = 1000
"""Maximum number of events to buffer before sink is attached."""

_event_queue: deque[dict[str, Any]] = deque(maxlen=_MAX_QUEUE_SIZE)
"""Events buffered before sink is attached."""

_device_id: str | None = None
_session_id: str | None = None
_client_info: tuple[str, str | None] | None = None
"""(name, version) tuple, set atomically via set_client_info."""
_sink: EventSink | None = None
_disabled: bool = False


def set_context(*, device_id: str, session_id: str) -> None:
    """Set device and session identifiers. Call once after app init."""
    global _device_id, _session_id
    _device_id = device_id
    _session_id = session_id


def set_client_info(*, name: str, version: str | None = None) -> None:
    """Set the wire/acp client name and version (e.g. VSCode 1.90.0, zed 0.180.0).

    Called by wire/acp servers after receiving the client's initialize message.
    Values are passed through verbatim — backend is responsible for any
    validation, normalization or alerting on anomalous values.
    """
    global _client_info
    if not name:
        return
    _client_info = (name, version)


def get_client_info() -> tuple[str, str | None] | None:
    """Return the current (name, version) tuple, or None if unset.

    Exposed for the sink to enrich events with the latest client info.
    """
    return _client_info


def disable() -> None:
    """Permanently disable telemetry for this process. Events are silently dropped."""
    global _disabled
    _disabled = True
    _event_queue.clear()
    if _sink is not None:
        _sink.clear_buffer()


def attach_sink(sink: EventSink) -> None:
    """Attach the event sink and drain any queued events.

    Multi-session ACP mode calls ``KimiCLI.create()`` per session, which
    means ``attach_sink`` runs again while a previous sink may hold
    un-flushed buffered events. Flush the old sink synchronously (writes
    any pending events to the disk fallback) before replacing it, so
    earlier sessions' events are not silently orphaned.
    """
    global _sink
    if _sink is not None and _sink is not sink:
        # flush_sync already swallows its own transport failures;
        # ``suppress`` guards against truly unexpected errors so sink
        # replacement is never blocked by a flaky predecessor.
        with suppress(Exception):
            _sink.flush_sync()
    _sink = sink
    # Drain events that were queued before sink was ready,
    # backfilling device_id/session_id for events tracked before set_context().
    if _event_queue:
        for event in _event_queue:
            if event.get("device_id") is None:
                event["device_id"] = _device_id
            if event.get("session_id") is None:
                event["session_id"] = _session_id
            _sink.accept(event)
        _event_queue.clear()


def track(event: str, **properties: bool | int | float | str | None) -> None:
    """
    Record a telemetry event.

    This function is non-blocking: it appends to an in-memory list.
    Safe to call from synchronous prompt_toolkit key handlers.

    Args:
        event: Event name (e.g. "input_command").
        **properties: Event properties. String values should only be used for
            known enum-like values (command names, mode names, error types).
            NEVER pass user input, file paths, or code snippets.
    """
    if _disabled:
        return

    record = {
        "event_id": uuid.uuid4().hex,
        "device_id": _device_id,
        "session_id": _session_id,
        "event": event,
        "timestamp": time.time(),
        "properties": properties if properties else {},
    }

    if _sink is not None:
        _sink.accept(record)
    else:
        _event_queue.append(record)


def get_sink() -> EventSink | None:
    """Return the current sink, or None if not attached."""
    return _sink


def flush_sync() -> None:
    """Synchronously flush any buffered events. Called on exit."""
    if _sink is not None:
        _sink.flush_sync()


# Register atexit handler to flush remaining events on normal exit
atexit.register(flush_sync)
