from __future__ import annotations

from typing import Any

import acp
import pytest
from kosong.message import ToolCall

from kimi_cli.acp.session import APPROVAL_REQUIRED_NOTIFICATION, ACPSession
from kimi_cli.wire.types import ApprovalRequest, Notification, TextPart, TurnBegin, TurnEnd


class _FakeConn:
    def __init__(self) -> None:
        self.updates: list[tuple[str, Any]] = []
        self.ext_notifications: list[tuple[str, dict[str, Any]]] = []

    async def session_update(self, session_id: str, update: object) -> None:
        self.updates.append((session_id, update))

    async def request_permission(
        self,
        options: list[acp.schema.PermissionOption],
        session_id: str,
        tool_call: acp.schema.ToolCallUpdate,
        **kwargs: object,
    ) -> acp.schema.RequestPermissionResponse:
        return acp.schema.RequestPermissionResponse(
            outcome=acp.schema.AllowedOutcome(outcome="selected", option_id="approve")
        )

    async def ext_notification(self, method: str, params: dict[str, object]) -> None:
        self.ext_notifications.append((method, params))


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


class _ApprovalCLI:
    async def run(self, _user_input, _cancel_event):
        tool_call = ToolCall(
            id="tool-1",
            function=ToolCall.FunctionBody(name="Shell", arguments='{"command": "make test"}'),
        )
        request = ApprovalRequest(
            id="approval-1",
            tool_call_id="tool-1",
            sender="Shell",
            action="Shell: make test",
            description="Run make test",
        )

        yield TurnBegin(user_input=[TextPart(text="hello")])
        yield tool_call
        yield request
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


@pytest.mark.asyncio
async def test_acp_session_sends_approval_required_ext_notification() -> None:
    conn = _FakeConn()
    session = ACPSession("session-1", _ApprovalCLI(), conn)  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("hello")])

    assert response.stop_reason == "end_turn"
    assert len(conn.ext_notifications) == 1
    method, params = conn.ext_notifications[0]
    assert method == APPROVAL_REQUIRED_NOTIFICATION
    tool_call_id = params.pop("tool_call_id")
    assert params == {
        "session_id": "session-1",
        "request_id": "approval-1",
        "title": "Kimi: Approval required",
        "message": "Kimi: Approval required. Please check the Kimi Code panel.",
        "action_label": "Open Kimi",
        "focus_command": "kimi.webview.focus",
        "tool_title": "Shell: make test",
        "approval_action": "Shell: make test",
        "description": "Run make test",
        "source_kind": None,
        "source_id": None,
    }
    assert isinstance(tool_call_id, str)
    assert tool_call_id.endswith("/tool-1")
