from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import acp
import pytest

from kimi_cli.acp.server import ACPServer
from kimi_cli.approval_runtime import ApprovalRuntime, ApprovalSource
from kimi_cli.soul.approval import Approval, ApprovalState

pytestmark = pytest.mark.asyncio


class _FakeConn:
    def __init__(self) -> None:
        self.updates: list[tuple[str, Any]] = []

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        self.updates.append((session_id, update))


def _server_with_approval(
    approval: Approval, approval_runtime: ApprovalRuntime
) -> tuple[ACPServer, _FakeConn]:
    conn = _FakeConn()
    server = ACPServer()
    server.conn = conn  # type: ignore[assignment]
    runtime = SimpleNamespace(approval=approval, approval_runtime=approval_runtime)
    soul = SimpleNamespace(runtime=runtime)
    cli = SimpleNamespace(soul=soul)
    acp_session = SimpleNamespace(cli=cli)
    server.sessions["session-1"] = (acp_session, object())  # type: ignore[assignment]
    return server, conn


async def test_set_session_mode_yolo_resolves_pending_approvals() -> None:
    approval_runtime = ApprovalRuntime()
    approval = Approval(
        state=ApprovalState(yolo=False),
        runtime=approval_runtime,
    )
    server, conn = _server_with_approval(approval, approval_runtime)

    approval_runtime.create_request(
        request_id="approval-1",
        tool_call_id="tool-1",
        sender="Shell",
        action="shell_exec",
        description="Run a command",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-1"),
    )

    await server.set_session_mode(mode_id="yolo", session_id="session-1")

    record = approval_runtime.get_request("approval-1")
    assert approval.is_yolo() is True
    assert record is not None
    assert record.status == "resolved"
    assert record.response == "approve"
    assert conn.updates == [
        (
            "session-1",
            acp.schema.CurrentModeUpdate(
                session_update="current_mode_update",
                current_mode_id="yolo",
            ),
        )
    ]


async def test_set_session_mode_default_disables_yolo() -> None:
    approval_runtime = ApprovalRuntime()
    approval = Approval(
        state=ApprovalState(yolo=True),
        runtime=approval_runtime,
    )
    server, conn = _server_with_approval(approval, approval_runtime)

    await server.set_session_mode(mode_id="default", session_id="session-1")

    assert approval.is_yolo() is False
    assert conn.updates == [
        (
            "session-1",
            acp.schema.CurrentModeUpdate(
                session_update="current_mode_update",
                current_mode_id="default",
            ),
        )
    ]
