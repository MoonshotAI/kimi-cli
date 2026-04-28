#!/usr/bin/env python3
"""Tiny local telemetry receiver for inspecting outbound events.

Point the telemetry endpoint at http://127.0.0.1:8765/v1/event, then run:

    uv run python scripts/telemetry_debug_server.py

Set EVENT_FILTER below to a bare event name such as "session_started" or to the
outbound name "kfc_session_started". Leave it as None to print every event.
"""

from __future__ import annotations

import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HOST = "127.0.0.1"
PORT = 8765

# None means print all events. Examples: "session_started", "kfc_session_started".
EVENT_FILTER: str | None = None

# The production transport prefixes outbound event names with "kfc_".
SERVER_EVENT_PREFIX = "kfc_"


def _canonical_event_name(name: str) -> str:
    if name.startswith(SERVER_EVENT_PREFIX):
        return name[len(SERVER_EVENT_PREFIX) :]
    return name


def _matches_event(event: dict[str, Any]) -> bool:
    if not EVENT_FILTER:
        return True
    name = event.get("event")
    if not isinstance(name, str):
        return False
    wanted = _canonical_event_name(EVENT_FILTER.strip())
    return _canonical_event_name(name) == wanted


def _compact_event_summary(event: dict[str, Any]) -> str:
    name = event.get("event", "<missing>")
    client = event.get("property_client_name")
    session_id = event.get("session_id")
    pieces = [str(name)]
    if client:
        pieces.append(f"client={client}")
    if session_id:
        pieces.append(f"session={session_id}")
    return " ".join(pieces)


class TelemetryHandler(BaseHTTPRequestHandler):
    server_version = "TelemetryDebugServer/0.1"

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"ok\n")

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"invalid json: {exc}\n".encode("utf-8", errors="replace"))
            return

        events = payload.get("events") if isinstance(payload, dict) else None
        if not isinstance(events, list):
            self.send_response(400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"payload must contain an events list\n")
            return

        matched = [event for event in events if isinstance(event, dict) and _matches_event(event)]
        if matched:
            now = datetime.now().isoformat(timespec="seconds")
            user_id = payload.get("user_id")
            print(
                f"\n[{now}] POST {self.path} user_id={user_id!r} "
                f"matched={len(matched)}/{len(events)}"
            )
            for idx, event in enumerate(matched, start=1):
                print(f"--- event {idx}: {_compact_event_summary(event)}")
                print(json.dumps(event, ensure_ascii=False, indent=2, sort_keys=True))

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}\n')

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    event_filter = EVENT_FILTER or "<all>"
    print(f"Telemetry debug server listening on http://{HOST}:{PORT}/v1/event")
    print(f"EVENT_FILTER = {event_filter}")
    with ThreadingHTTPServer((HOST, PORT), TelemetryHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping telemetry debug server.")


if __name__ == "__main__":
    main()
