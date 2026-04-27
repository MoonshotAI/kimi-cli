from __future__ import annotations

import asyncio
from pathlib import Path

import acp
import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.acp.session import ACPSession
from kimi_cli.app import KimiCLI
from kimi_cli.approval_runtime import get_current_approval_source_or_none
from kimi_cli.soul import wire_send
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import Notification, TextPart, ToolCall, TurnBegin, TurnEnd


class _FakeConn:
    def __init__(self) -> None:
        from typing import Any

        self.updates: list[tuple[str, Any]] = []

    async def session_update(self, session_id: str, update: object) -> None:
        self.updates.append((session_id, update))


class _FakeCLI:
    async def run(self, _user_input, _cancel_event):
        yield TurnBegin(user_input=[TextPart(text="hello")])
        yield Notification(
            id="n1234567",
            category="task",
            type="task.completed",
            source_kind="background_task",
            source_id="b1234567",
            title="Background task completed: build project",
            body="Task ID: b1234567\nStatus: completed",
            severity="success",
            created_at=123.456,
            payload={"task_id": "b1234567"},
        )
        yield TextPart(text="done")
        yield TurnEnd()


@pytest.mark.asyncio
async def test_acp_session_surfaces_notification_as_message_chunk() -> None:
    conn = _FakeConn()
    session = ACPSession("session-1", _FakeCLI(), conn)  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("hello")])

    assert response.stop_reason == "end_turn"
    assert len(conn.updates) == 2
    notification_update = conn.updates[0][1]
    text_update = conn.updates[1][1]
    assert notification_update.content.text.startswith(
        "[Notification] Background task completed: build project"
    )
    assert "Task ID: b1234567" in notification_update.content.text
    assert text_update.content.text == "done"


class _BlockingApprovalConn(_FakeConn):
    def __init__(self) -> None:
        super().__init__()
        self.permission_requested = asyncio.Event()

    async def request_permission(
        self,
        options: list[acp.schema.PermissionOption],
        session_id: str,
        tool_call: acp.schema.ToolCallUpdate,
        **kwargs,
    ) -> acp.schema.RequestPermissionResponse:
        self.permission_requested.set()
        pending: asyncio.Future[acp.schema.RequestPermissionResponse] = asyncio.Future()
        return await pending


@pytest.mark.asyncio
async def test_acp_prompt_cancel_closes_abandoned_approval_stream(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert runtime.approval_runtime is not None

    async def fake_turn(self, _user_message):
        source = get_current_approval_source_or_none()
        assert source is not None
        tool_call_id = "call-acp-abandoned-approval"
        wire_send(
            ToolCall(
                id=tool_call_id,
                function=ToolCall.FunctionBody(name="WriteFile", arguments="{}"),
            )
        )
        request = runtime.approval_runtime.create_request(
            request_id="req-acp-abandoned-approval",
            tool_call_id=tool_call_id,
            sender="WriteFile",
            action="edit file",
            description="write file",
            display=[],
            source=source,
        )
        await runtime.approval_runtime.wait_for_response(request.id)

    async def fake_ensure_fresh(_runtime):
        return None

    monkeypatch.setattr(KimiSoul, "_turn", fake_turn)
    monkeypatch.setattr(runtime.oauth, "ensure_fresh", fake_ensure_fresh)

    soul = KimiSoul(
        Agent(
            name="ACP Approval Agent",
            system_prompt="System prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=Context(file_backend=tmp_path / "history.jsonl"),
    )
    conn = _BlockingApprovalConn()
    session = ACPSession("session-1", KimiCLI(soul, runtime, {}), conn)  # type: ignore[arg-type]
    prompt_task = asyncio.create_task(session.prompt([acp.text_block("hello")]))

    await asyncio.wait_for(conn.permission_requested.wait(), timeout=1.0)
    prompt_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(prompt_task, timeout=1.0)

    async def wait_for_cancelled_approval() -> None:
        for _ in range(20):
            record = runtime.approval_runtime.get_request("req-acp-abandoned-approval")
            if record is not None and record.status == "cancelled":
                return
            await asyncio.sleep(0.01)
        pytest.fail("approval request was not cancelled")

    await wait_for_cancelled_approval()
    record = runtime.approval_runtime.get_request("req-acp-abandoned-approval")
    assert record is not None
    assert record.status == "cancelled"
    assert record.response == "reject"
    assert runtime.approval_runtime.list_pending() == []
