from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from kosong.message import ContentPart
from kosong.tooling.empty import EmptyToolset

import kimi_cli.telemetry as telemetry_mod
from kimi_cli.approval_runtime import ApprovalSource
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.telemetry import set_context
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire.jsonrpc import (
    ClientInfo,
    ErrorCodes,
    JSONRPCErrorResponse,
    JSONRPCEventMessage,
    JSONRPCPromptMessage,
    JSONRPCSteerMessage,
    JSONRPCSuccessResponse,
    Statuses,
)
from kimi_cli.wire.server import WireServer
from kimi_cli.wire.types import ApprovalRequest, ApprovalResponse, TextPart


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Steer Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _reset_telemetry() -> None:
    telemetry_mod._event_queue.clear()
    telemetry_mod._device_id = None
    telemetry_mod._session_id = None
    telemetry_mod._client_info = None
    telemetry_mod._session_started_sessions.clear()
    telemetry_mod._sink = None
    telemetry_mod._disabled = False


def test_wire_client_info_emits_session_started(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    _reset_telemetry()
    try:
        set_context(device_id="dev-wire", session_id=runtime.session.id)
        runtime.ui_mode = "wire"
        runtime.resumed = True
        soul = _make_soul(runtime, tmp_path)
        server = WireServer(soul)

        server._track_session_started(ClientInfo(name="kiwi", version="1.2.3"))

        event = telemetry_mod._event_queue[-1]
        assert event["event"] == "session_started"
        assert event["session_id"] == runtime.session.id
        assert event["properties"]["client_name"] == "kiwi"
        assert event["properties"]["client_version"] == "1.2.3"
        assert event["properties"]["ui_mode"] == "wire"
        assert event["properties"]["resumed"] is True
    finally:
        _reset_telemetry()


@pytest.mark.asyncio
async def test_handle_steer_returns_invalid_state_when_not_streaming(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)

    response = await server._handle_steer(
        JSONRPCSteerMessage(
            id="1",
            params=JSONRPCSteerMessage.Params(user_input=[TextPart(text="follow-up")]),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.INVALID_STATE


@pytest.mark.asyncio
async def test_handle_steer_queues_input_when_streaming(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)
    queued: list[str | list[ContentPart]] = []

    monkeypatch.setattr(soul, "steer", lambda user_input: queued.append(user_input))
    server._cancel_event = asyncio.Event()

    response = await server._handle_steer(
        JSONRPCSteerMessage(
            id="1",
            params=JSONRPCSteerMessage.Params(user_input=[TextPart(text="follow-up")]),
        )
    )

    assert isinstance(response, JSONRPCSuccessResponse)
    assert response.result == {"status": Statuses.STEERED}
    assert queued == [[TextPart(text="follow-up")]]


@pytest.mark.asyncio
async def test_shutdown_rejects_foreground_approval_in_runtime(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)
    assert runtime.approval_runtime is not None

    runtime.approval_runtime.create_request(
        request_id="req-wire-shutdown-1",
        tool_call_id="call-wire-shutdown-1",
        sender="WriteFile",
        action="edit file",
        description="write file",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-wire-shutdown-1"),
    )
    request = ApprovalRequest(
        id="req-wire-shutdown-1",
        tool_call_id="call-wire-shutdown-1",
        sender="WriteFile",
        action="edit file",
        description="write file",
        source_kind="foreground_turn",
        source_id="turn-wire-shutdown-1",
    )
    server._pending_requests[request.id] = request

    await server._shutdown()

    assert request.resolved is True
    assert runtime.approval_runtime is not None
    record = runtime.approval_runtime.get_request("req-wire-shutdown-1")
    assert record is not None
    assert record.status == "resolved"
    assert record.response == "reject"
    assert runtime.approval_runtime.list_pending() == []


@pytest.mark.asyncio
async def test_root_hub_loop_survives_message_handler_errors(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)
    server._initialized = True

    request = ApprovalRequest(
        id="req-root-hub-1",
        tool_call_id="call-root-hub-1",
        sender="WriteFile",
        action="edit file",
        description="write file",
        source_kind="foreground_turn",
        source_id="turn-root-hub-1",
    )
    response = ApprovalResponse(request_id="req-root-hub-1", response="approve")

    class _Queue:
        def __init__(self) -> None:
            self._messages = [request, response]

        async def get(self):
            if self._messages:
                return self._messages.pop(0)
            raise QueueShutDown

    seen_requests: list[str] = []
    sent_events: list[JSONRPCEventMessage] = []

    async def fake_request_approval(msg: ApprovalRequest) -> None:
        seen_requests.append(msg.id)
        raise RuntimeError("boom")

    async def fake_send_msg(msg) -> None:
        assert isinstance(msg, JSONRPCEventMessage)
        sent_events.append(msg)

    server._root_hub_queue = _Queue()  # type: ignore[assignment]
    monkeypatch.setattr(server, "_request_approval", fake_request_approval)
    monkeypatch.setattr(server, "_send_msg", fake_send_msg)

    await server._root_hub_loop()

    assert seen_requests == ["req-root-hub-1"]
    assert len(sent_events) == 1
    assert sent_events[0].params == response


@pytest.mark.asyncio
async def test_handle_prompt_cleanup_keeps_background_approval_pending(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)

    request = ApprovalRequest(
        id="req-bg-prompt-1",
        tool_call_id="call-bg-prompt-1",
        sender="WriteFile",
        action="edit file",
        description="write file",
        source_kind="background_agent",
        source_id="task-bg-prompt-1",
    )
    server._pending_requests[request.id] = request

    async def fake_run_soul(*args, **kwargs):
        return None

    monkeypatch.setattr("kimi_cli.wire.server.run_soul", fake_run_soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="prompt-1",
            params=JSONRPCPromptMessage.Params(user_input=[TextPart(text="run prompt")]),
        )
    )

    assert isinstance(response, JSONRPCSuccessResponse)
    assert response.result == {"status": Statuses.FINISHED}
    assert server._pending_requests == {"req-bg-prompt-1": request}
    assert runtime.approval_runtime is not None
    record = runtime.approval_runtime.get_request("req-bg-prompt-1")
    assert record is None
