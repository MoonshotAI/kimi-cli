"""E2E regression test for Kimi-compatible endpoints that reject empty assistant text.

This reproduces the real compatibility issue against a local mock server:

1. First response returns an assistant tool call with no visible text.
2. The CLI executes the tool and sends the next request with conversation history.
3. Some Kimi-compatible gateways reject the second request if the prior assistant
   tool-call message contains `content: []` / `content: ""`, returning
   `400 {"error": {"message": "text content is empty"}}`.

The provider should omit `content` for assistant tool-call messages when the
content is effectively empty.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Protocol, cast

import pytest_asyncio
from aiohttp import web


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


class MockKimiCompatServer(Protocol):
    base_url: str
    requests: list[dict[str, Any]]


class _MockKimiCompatServer:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.requests: list[dict[str, Any]] = []


async def _write_sse_event(response: web.StreamResponse, payload: dict[str, Any]) -> None:
    await response.write(f"data: {json.dumps(payload)}\n\n".encode())


async def _write_sse_done(response: web.StreamResponse) -> None:
    await response.write(b"data: [DONE]\n\n")
    await response.write_eof()


def _tool_call_stream_chunk() -> dict[str, Any]:
    return {
        "id": "chatcmpl-tool-call",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "kimi-for-coding",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_read",
                            "type": "function",
                            "function": {
                                "name": "ReadFile",
                                "arguments": '{"path":"sample.txt"}',
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
    }


def _final_stream_chunk() -> dict[str, Any]:
    return {
        "id": "chatcmpl-final",
        "object": "chat.completion.chunk",
        "created": 2,
        "model": "kimi-for-coding",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "content": "Read finished.",
                },
                "finish_reason": "stop",
            }
        ],
    }


def _error_response() -> dict[str, Any]:
    return {
        "error": {
            "message": "text content is empty",
            "type": "invalid_request_error",
        }
    }


def _find_assistant_tool_call_message(body: dict[str, Any]) -> dict[str, Any] | None:
    raw_messages = body.get("messages")
    if not isinstance(raw_messages, list):
        return None
    for raw_message in raw_messages:
        if not isinstance(raw_message, dict):
            continue
        message = cast(dict[str, Any], raw_message)
        if message.get("role") == "assistant" and message.get("tool_calls"):
            return message
    return None


def _content_is_effectively_empty(content: Any) -> bool:
    if content is None:
        return True
    if isinstance(content, str):
        return not content.strip()
    if not isinstance(content, list):
        return False
    for item in content:
        if not isinstance(item, dict):
            return False
        if item.get("type") != "text":
            return False
        text = item.get("text")
        if not isinstance(text, str) or text.strip():
            return False
    return True


@pytest_asyncio.fixture
async def mock_kimi_compat_server() -> AsyncIterator[MockKimiCompatServer]:
    server_holder: _MockKimiCompatServer | None = None

    async def handler(request: web.Request) -> web.StreamResponse:
        assert server_holder is not None
        body = cast(dict[str, Any], await request.json())
        server_holder.requests.append(body)

        if len(server_holder.requests) == 1:
            response = web.StreamResponse(
                status=200,
                headers={"Content-Type": "text/event-stream"},
            )
            await response.prepare(request)
            await _write_sse_event(response, _tool_call_stream_chunk())
            await _write_sse_done(response)
            return response

        assistant_message = _find_assistant_tool_call_message(body)
        if assistant_message is None:
            raise AssertionError(f"Missing assistant tool-call message in body: {body}")
        if "content" in assistant_message and _content_is_effectively_empty(
            assistant_message["content"]
        ):
            return web.json_response(_error_response(), status=400)
        response = web.StreamResponse(
            status=200,
            headers={"Content-Type": "text/event-stream"},
        )
        await response.prepare(request)
        await _write_sse_event(response, _final_stream_chunk())
        await _write_sse_done(response)
        return response

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="127.0.0.1", port=0)
    await site.start()

    sockets = site._server.sockets  # type: ignore[attr-defined]
    assert sockets, "Server failed to bind to a port."
    port = sockets[0].getsockname()[1]
    server_holder = _MockKimiCompatServer(f"http://127.0.0.1:{port}")

    try:
        yield server_holder
    finally:
        await runner.cleanup()


def _write_kimi_config(config_path: Path, *, base_url: str) -> None:
    config_path.write_text(
        json.dumps(
            {
                "default_model": "mock-kimi",
                "models": {
                    "mock-kimi": {
                        "provider": "mock-kimi-provider",
                        "model": "kimi-for-coding",
                        "max_context_size": 100000,
                    }
                },
                "providers": {
                    "mock-kimi-provider": {
                        "type": "kimi",
                        "base_url": base_url,
                        "api_key": "test-api-key",
                    }
                },
            }
        ),
        encoding="utf-8",
    )


async def _run_kimi_print_json(
    *,
    config_path: Path,
    share_dir: Path,
    work_dir: Path,
    prompt: str,
) -> tuple[int, str, str]:
    env = os.environ.copy()
    env["KIMI_SHARE_DIR"] = str(share_dir)
    env["KIMI_DISABLE_TELEMETRY"] = "1"
    env["COLUMNS"] = "120"
    env["LINES"] = "40"

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "kimi_cli.cli",
        "--print",
        "--output-format",
        "stream-json",
        "--final-message-only",
        "--prompt",
        prompt,
        "--config-file",
        str(config_path),
        "--work-dir",
        str(work_dir),
        cwd=str(_repo_root()),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stdout_bytes, stderr_bytes = await process.communicate()
    assert process.returncode is not None
    return process.returncode, stdout_bytes.decode(), stderr_bytes.decode()


def _extract_final_message(stdout: str) -> dict[str, Any]:
    lines = [line for line in stdout.splitlines() if line.strip()]
    assert lines, "Expected at least one JSON line in stdout."
    return cast(dict[str, Any], json.loads(lines[-1]))


async def test_kimi_compat_endpoint_accepts_tool_call_history_without_empty_content(
    tmp_path: Path, mock_kimi_compat_server: MockKimiCompatServer
) -> None:
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    (work_dir / "sample.txt").write_text("hello from sample\n", encoding="utf-8")

    share_dir = tmp_path / "share"
    share_dir.mkdir()

    config_path = tmp_path / "config.json"
    _write_kimi_config(config_path, base_url=f"{mock_kimi_compat_server.base_url}/v1")

    return_code, stdout, stderr = await _run_kimi_print_json(
        config_path=config_path,
        share_dir=share_dir,
        work_dir=work_dir,
        prompt="Read sample.txt with ReadFile and then confirm success.",
    )

    assert return_code == 0, f"stdout:\n{stdout}\nstderr:\n{stderr}"
    assert _extract_final_message(stdout) == {
        "role": "assistant",
        "content": "Read finished.",
    }

    assert len(mock_kimi_compat_server.requests) == 2
    assistant_message = _find_assistant_tool_call_message(mock_kimi_compat_server.requests[1])
    assert assistant_message is not None
    assert "content" not in assistant_message
