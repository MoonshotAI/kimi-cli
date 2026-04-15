from __future__ import annotations

import acp
import pytest

from kimi_cli.acp.session import ACPSession
from kimi_cli.wire.types import BtwBegin, BtwEnd, Notification, TextPart, TurnBegin, TurnEnd


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


class _FakeBtwCLI:
    def __init__(self, end: BtwEnd) -> None:
        self._end = end

    async def run(self, _user_input, _cancel_event):
        yield TurnBegin(user_input=[TextPart(text="/btw check this")])
        yield BtwBegin(id="btw-1", question="check this")
        yield self._end
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
async def test_acp_session_surfaces_btw_response_as_message_chunk() -> None:
    conn = _FakeConn()
    session = ACPSession(
        "session-1",
        _FakeBtwCLI(BtwEnd(id="btw-1", response="side answer")),
        conn,
    )  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("/btw check this")])

    assert response.stop_reason == "end_turn"
    assert len(conn.updates) == 1
    update = conn.updates[0][1]
    assert update.content.text == "side answer"


@pytest.mark.asyncio
async def test_acp_session_surfaces_btw_error_as_message_chunk() -> None:
    conn = _FakeConn()
    session = ACPSession(
        "session-1",
        _FakeBtwCLI(BtwEnd(id="btw-1", error="side question failed")),
        conn,
    )  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("/btw check this")])

    assert response.stop_reason == "end_turn"
    assert len(conn.updates) == 1
    update = conn.updates[0][1]
    assert update.content.text == "Error: side question failed"
