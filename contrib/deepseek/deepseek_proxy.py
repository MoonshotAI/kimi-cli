#!/usr/bin/env python3
"""
DeepSeek API Proxy - Max Thinking Mode with reasoning_content round-trip.

Sits between Kimi CLI and DeepSeek API to:
  1. Inject "thinking":{"type":"enabled"} + "reasoning_effort":"max" into requests
  2. Store reasoning_content from DeepSeek responses
  3. Re-inject reasoning_content into multi-turn assistant messages
     (Kimi CLI drops this field, causing 400 errors on turn 2+)
  4. Handle both streaming and non-streaming responses

Usage:
    python3 ~/.kimi-code/deepseek_proxy.py &
    # Then set base_url = "http://localhost:18923/v1" in Kimi CLI config

Requires: Python 3.8+ (stdlib only - no pip packages needed)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ─── Configuration ───────────────────────────────────────────────────────────

LOG_FILE = os.path.expanduser("~/.kimi-code/proxy.log")
DEEPSEEK_BASE = "https://api.deepseek.com"
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 18923

# ─── Reasoning Content Store (thread-safe) ───────────────────────────────────

_reasoning_store: dict[str, str] = {}
_reasoning_lock = threading.Lock()


def store_reasoning(content: str, reasoning: str) -> None:
    """Store reasoning_content keyed by assistant message content."""
    if not content or not reasoning:
        return
    with _reasoning_lock:
        _reasoning_store[content] = reasoning
    log.info("stored reasoning_content (%d chars) for content (%d chars)",
             len(reasoning), len(content))


def lookup_reasoning(content: str) -> str | None:
    """Retrieve stored reasoning_content for an assistant message."""
    with _reasoning_lock:
        return _reasoning_store.get(content)


def inject_missing_reasoning(messages: list[dict]) -> bool:
    """Inject stored reasoning_content into assistant messages that lack it.
    Returns True if any injection was performed."""
    modified = False
    for msg in messages:
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            if "reasoning_content" not in msg and content:
                stored = lookup_reasoning(content)
                if stored is not None:
                    msg["reasoning_content"] = stored
                    modified = True
                    log.info("injected reasoning_content for assistant msg (%d chars)", len(content))
    return modified


# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, mode="a"),
        logging.StreamHandler(sys.stderr),
    ],
)
log = logging.getLogger("deepseek-proxy")

# Silence noisy HTTP server access log
logging.getLogger("deepseek-proxy.access").setLevel(logging.WARNING)


# ─── HTTP Server ─────────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class DeepSeekProxyHandler(BaseHTTPRequestHandler):
    """HTTP request handler that proxies to DeepSeek API with thinking injection."""

    # Suppress BaseHTTPRequestHandler's own stderr logging for every request
    def log_message(self, fmt: str, *args: Any) -> None:  # type: ignore[override]
        logging.getLogger("deepseek-proxy.access").info(
            "%s - %s", self.client_address[0], fmt % args
        )

    # ── Helpers ──────────────────────────────────────────────────────────

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length > 0 else b""

    def _forward(
        self, method: str, path: str, body: bytes | None = None
    ):
        """Forward request to DeepSeek; return response object or None."""
        url = f"{DEEPSEEK_BASE}{path}"
        # Copy headers, excluding hop-by-hop headers
        headers = {
            k: v
            for k, v in self.headers.items()
            if k.lower()
            not in (
                "host",
                "content-length",
                "content-encoding",
                "transfer-encoding",
                "connection",
                "keep-alive",
                "proxy-connection",
                "upgrade",
            )
        }
        headers["Host"] = "api.deepseek.com"

        req = Request(url, data=body, headers=headers, method=method)
        try:
            return urlopen(req, timeout=300)
        except HTTPError as e:
            return e  # forward HTTP errors to client
        except URLError as e:
            log.error("upstream connection error: %s", e)
            return None

    def _send_upstream_response(self, resp) -> None:
        """Forward upstream response (status + headers + body) verbatim."""
        body = resp.read()
        self.send_response(resp.status)
        # Copy safe headers
        for key, value in resp.headers.items():
            k = key.lower()
            if k not in (
                "transfer-encoding",
                "content-encoding",
                "connection",
                "keep-alive",
            ):
                try:
                    self.send_header(key, value)
                except Exception:
                    pass
        # Override content-length to match our read body
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json_error(self, status: int, message: str) -> None:
        data = json.dumps({"error": {"message": message, "type": "proxy_error"}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ── Route Handlers ──────────────────────────────────────────────────

    def do_GET(self) -> None:
        path = self.path
        log.info("GET %s (passthrough)", path)
        resp = self._forward("GET", path)
        if resp:
            self._send_upstream_response(resp)
        else:
            self._send_json_error(502, "Upstream connection failed")

    def do_POST(self) -> None:
        path = self.path
        body = self._read_body()

        if path.rstrip("/") == "/v1/chat/completions":
            self._handle_chat_completions(body)
        else:
            log.info("POST %s (passthrough)", path)
            resp = self._forward("POST", path, body)
            if resp:
                self._send_upstream_response(resp)
            else:
                self._send_json_error(502, "Upstream connection failed")

    # ── Chat Completions Handler ────────────────────────────────────────

    def _handle_chat_completions(self, body: bytes) -> None:
        try:
            req_data: dict = json.loads(body)
        except json.JSONDecodeError:
            self._send_json_error(400, "Invalid JSON in request body")
            return

        # ── Inject thinking parameters ──
        if "thinking" not in req_data:
            req_data["thinking"] = {"type": "enabled"}
        if "reasoning_effort" not in req_data:
            req_data["reasoning_effort"] = "max"

        # ── Inject stored reasoning_content into assistant messages ──
        messages = req_data.get("messages", [])
        injected = inject_missing_reasoning(messages)

        is_stream = req_data.get("stream", False)
        modified_body = json.dumps(req_data).encode("utf-8")

        log.info(
            "chat completion: stream=%s msgs=%d thinking=enabled effort=max%s",
            is_stream,
            len(messages),
            " (injected reasoning_content)" if injected else "",
        )

        resp = self._forward("POST", "/v1/chat/completions", modified_body)
        if resp is None:
            self._send_json_error(502, "Upstream connection failed")
            return

        if resp.status != 200:
            # Pass through error responses (e.g., 400, 401, 429, 500)
            self._send_upstream_response(resp)
            return

        if is_stream:
            self._handle_stream_response(resp)
        else:
            self._handle_non_stream_response(resp)

    # ── Non-streaming Response ──────────────────────────────────────────

    def _handle_non_stream_response(self, resp) -> None:
        try:
            resp_data: dict = json.loads(resp.read())
        except Exception as e:
            log.error("failed to parse non-streaming response: %s", e)
            self._send_json_error(502, "Invalid upstream response")
            return

        # Store reasoning_content from each choice
        for choice in resp_data.get("choices", []):
            msg = choice.get("message", {})
            store_reasoning(msg.get("content", ""), msg.get("reasoning_content"))

        # Forward response to client
        resp_body = json.dumps(resp_data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    # ── Streaming (SSE) Response ────────────────────────────────────────

    def _handle_stream_response(self, resp) -> None:
        """Forward SSE stream line-by-line, capturing reasoning_content."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")  # disable nginx buffering
        self.end_headers()

        accumulated_content = ""
        accumulated_reasoning = ""

        try:
            while True:
                line_bytes = resp.readline()
                if not line_bytes:
                    break

                # ── Forward raw line to client immediately ──
                self.wfile.write(line_bytes)
                self.wfile.flush()

                # ── Parse SSE data for reasoning_content capture ──
                if line_bytes.startswith(b"data: "):
                    data_str = (
                        line_bytes[6:].decode("utf-8", errors="replace").strip()
                    )
                    if data_str == "[DONE]":
                        continue
                    try:
                        data = json.loads(data_str)
                        for choice in data.get("choices", []):
                            delta = choice.get("delta", {})
                            rc = delta.get("reasoning_content")
                            content = delta.get("content")
                            if rc:
                                accumulated_reasoning += rc
                            if content:
                                accumulated_content += content
                    except json.JSONDecodeError:
                        pass  # malformed JSON in SSE — skip silently
        except ConnectionError:
            log.info("client disconnected during stream")
        except Exception as e:
            log.error("stream error: %s", e)
        finally:
            try:
                resp.close()
            except Exception:
                pass

        # Store final reasoning_content after stream completes
        if accumulated_reasoning and accumulated_content:
            store_reasoning(accumulated_content, accumulated_reasoning)

        self.wfile.flush()


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    # Ensure ~/.kimi-code directory exists
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

    server = ThreadedHTTPServer((PROXY_HOST, PROXY_PORT), DeepSeekProxyHandler)
    log.info("=" * 50)
    log.info("DeepSeek Proxy Starting")
    log.info("Listening:  http://%s:%s", PROXY_HOST, PROXY_PORT)
    log.info("Upstream:   %s/v1", DEEPSEEK_BASE)
    log.info("Thinking:   enabled  |  reasoning_effort: max")
    log.info("Log file:   %s", LOG_FILE)
    log.info("=" * 50)

    print(
        f"  DeepSeek proxy running on http://{PROXY_HOST}:{PROXY_PORT}",
        file=sys.stderr,
    )
    print(
        f"  Set providers.deepseek.base_url = http://localhost:{PROXY_PORT}/v1",
        file=sys.stderr,
    )
    print(f"  Logging to {LOG_FILE}", file=sys.stderr)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down...")
        server.shutdown()
        print("\n  Proxy stopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
