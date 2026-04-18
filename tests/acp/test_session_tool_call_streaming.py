from __future__ import annotations

import acp
import pytest

from kimi_cli.acp.session import ACPSession
from kimi_cli.wire.types import ToolCall, ToolCallPart, TurnBegin, TurnEnd


class _FakeConn:
    def __init__(self) -> None:
        from typing import Any

        self.updates: list[tuple[str, Any]] = []

    async def session_update(self, session_id: str, update: object) -> None:
        self.updates.append((session_id, update))


class _StreamingToolCallCLI:
    async def run(self, _user_input, _cancel_event):
        yield TurnBegin(user_input="write a large file")
        yield ToolCall(
            id="tc-1",
            function=ToolCall.FunctionBody(name="WriteFile", arguments="{"),
        )
        yield ToolCallPart(arguments_part='"path":"big.py",')
        yield ToolCallPart(arguments_part='"content":"line 1\\n')
        yield ToolCallPart(arguments_part='line 2\\nline 3"}')
        yield TurnEnd()


@pytest.mark.asyncio
async def test_acp_tool_call_progress_does_not_resend_accumulated_arguments() -> None:
    conn = _FakeConn()
    session = ACPSession("session-1", _StreamingToolCallCLI(), conn)  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("hello")])

    assert response.stop_reason == "end_turn"
    assert len(conn.updates) == 4

    start_update = conn.updates[0][1]
    progress_updates = [update for _, update in conn.updates[1:]]

    assert start_update.session_update == "tool_call"
    assert start_update.content[0].content.text == "{"

    # Intermediate progress updates may carry the new chunk for preview, but must
    # not resend the full accumulated arguments each time.
    assert all(update.session_update == "tool_call_update" for update in progress_updates)
    assert all(update.status == "in_progress" for update in progress_updates)
    assert [update.content[0].content.text for update in progress_updates] == [
        '"path":"big.py",',
        '"content":"line 1\\n',
        'line 2\\nline 3"}',
    ]

    # Title extraction should still work even when the streamed JSON is incomplete.
    assert progress_updates[-1].title == "WriteFile: big.py"
