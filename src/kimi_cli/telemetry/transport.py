"""
AsyncTransport: HTTP sending with 401 fallback, disk persistence, startup retry.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import aiohttp

from kimi_cli.share import get_share_dir
from kimi_cli.utils.logging import logger

# Mock endpoint — replace with real endpoint when backend is ready
TELEMETRY_ENDPOINT = "https://telemetry.kimi.com/api/v1/events"

SEND_TIMEOUT = aiohttp.ClientTimeout(total=10, sock_connect=5)
DISK_EVENT_MAX_AGE_S = 7 * 24 * 3600  # 7 days


def _telemetry_dir() -> Path:
    path = get_share_dir() / "telemetry"
    path.mkdir(parents=True, exist_ok=True)
    return path


class AsyncTransport:
    """Sends telemetry events over HTTP with disk fallback."""

    def __init__(
        self,
        *,
        get_access_token: Callable[[], str | None] | None = None,
        endpoint: str = TELEMETRY_ENDPOINT,
    ) -> None:
        """
        Args:
            get_access_token: Callable that returns the current OAuth access token
                (or None if not logged in). Read-only, must not trigger refresh.
            endpoint: HTTP endpoint to POST events to.
        """
        self._get_access_token = get_access_token
        self._endpoint = endpoint

    async def send(self, events: list[dict[str, Any]]) -> None:
        """Send a batch of events. Falls back to disk on failure."""
        if not events:
            return

        payload = {"events": events}

        try:
            await self._send_http(payload)
        except _TransientError:
            # Network/server error — save to disk for retry
            self.save_to_disk(events)
        except Exception:
            logger.debug("Telemetry send failed unexpectedly")
            self.save_to_disk(events)

    async def _send_http(self, payload: dict[str, Any]) -> None:
        """Attempt HTTP POST with 401 anonymous fallback."""
        from kimi_cli.utils.aiohttp import new_client_session

        token = self._get_access_token() if self._get_access_token else None
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        async with new_client_session(timeout=SEND_TIMEOUT) as session:
            try:
                async with session.post(self._endpoint, json=payload, headers=headers) as resp:
                    if resp.status == 401 and token:
                        # Auth failed — retry without token (anonymous)
                        headers.pop("Authorization", None)
                        async with session.post(
                            self._endpoint, json=payload, headers=headers
                        ) as retry_resp:
                            if retry_resp.status >= 500:
                                raise _TransientError(f"HTTP {retry_resp.status}")
                            elif retry_resp.status >= 400:
                                # Client error (4xx) — not recoverable, don't retry
                                logger.debug(
                                    "Anonymous retry got client error HTTP {status}, dropping",
                                    status=retry_resp.status,
                                )
                                return
                            return
                    elif resp.status >= 400:
                        raise _TransientError(f"HTTP {resp.status}")
            except (aiohttp.ClientError, TimeoutError) as exc:
                raise _TransientError(str(exc)) from exc

    def save_to_disk(self, events: list[dict[str, Any]]) -> None:
        """Persist events to disk for later retry. Append-only JSONL."""
        if not events:
            return
        try:
            path = _telemetry_dir() / f"failed_{uuid.uuid4().hex[:12]}.jsonl"
            with open(path, "a", encoding="utf-8") as f:
                for event in events:
                    f.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
                    f.write("\n")
            logger.debug(
                "Saved {count} telemetry events to {path}",
                count=len(events),
                path=path,
            )
        except Exception:
            logger.debug("Failed to save telemetry events to disk")

    async def retry_disk_events(self) -> None:
        """On startup, scan disk for persisted events and resend them."""
        telemetry_dir = _telemetry_dir()
        failed_files = list(telemetry_dir.glob("failed_*.jsonl"))
        if not failed_files:
            return

        now = time.time()
        for path in failed_files:
            # Delete files older than DISK_EVENT_MAX_AGE_S
            try:
                if now - path.stat().st_mtime > DISK_EVENT_MAX_AGE_S:
                    logger.debug("Removing expired telemetry file: {path}", path=path)
                    path.unlink(missing_ok=True)
                    continue
            except OSError:
                pass

            try:
                events: list[dict[str, Any]] = []
                with open(path, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            events.append(json.loads(line))
                if events:
                    await self._send_http({"events": events})
                # Success — delete the file
                path.unlink(missing_ok=True)
                logger.debug(
                    "Retried {count} telemetry events from {path}",
                    count=len(events),
                    path=path,
                )
            except _TransientError:
                # Still failing — leave file for next startup
                logger.debug("Retry of {path} failed, will try again later", path=path)
            except json.JSONDecodeError:
                # Corrupted file — delete it
                logger.debug("Removing corrupted telemetry file: {path}", path=path)
                path.unlink(missing_ok=True)
            except Exception:
                # Unexpected error — leave file for next startup
                logger.debug("Unexpected error retrying {path}, will try again later", path=path)


class _TransientError(Exception):
    """Raised on transient HTTP/network errors to trigger disk fallback."""
