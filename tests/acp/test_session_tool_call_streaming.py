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
async def test_acp_tool_call_progress_only_updates_when_streaming_title_changes() -> None:
    conn = _FakeConn()
    session = ACPSession("session-1", _StreamingToolCallCLI(), conn)  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("hello")])

    assert response.stop_reason == "end_turn"
    assert len(conn.updates) == 2

    start_update = conn.updates[0][1]
    progress_update = conn.updates[1][1]

    assert start_update.session_update == "tool_call"
    assert start_update.content[0].content.text == "{"

    # ToolCallProgress.content replaces the current content collection, so ACP
    # only sends a progress update when the title changes and includes the
    # accumulated args snapshot for that new title.
    assert progress_update.session_update == "tool_call_update"
    assert progress_update.status == "in_progress"
    assert progress_update.content[0].content.text == '{"path":"big.py",'

    # Title extraction should still work even when the streamed JSON is incomplete.
    assert progress_update.title == "WriteFile: big.py"
