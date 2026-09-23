from __future__ import annotations

from typing import Any

import acp
import pytest

from kimi_cli.acp.session import ACPSession
from kimi_cli.wire.types import (
    QuestionItem,
    QuestionNotSupported,
    QuestionOption,
    QuestionRequest,
    TextPart,
    TurnBegin,
    TurnEnd,
)


class _FakeConn:
    def __init__(self) -> None:
        self.updates: list[tuple[str, Any]] = []

    async def session_update(self, session_id: str, update: object) -> None:
        self.updates.append((session_id, update))


def _make_question_request() -> QuestionRequest:
    return QuestionRequest(
        id="q1",
        tool_call_id="tc1",
        questions=[
            QuestionItem(
                question="Which option?",
                header="Choice",
                options=[QuestionOption(label="A"), QuestionOption(label="B")],
                multi_select=False,
            )
        ],
    )


class _QuestionCLI:
    def __init__(self, request: QuestionRequest) -> None:
        self._request = request

    async def run(self, _user_input, _cancel_event):
        yield TurnBegin(user_input=[TextPart(text="hello")])
        yield self._request
        yield TurnEnd()


@pytest.mark.asyncio
async def test_acp_session_signals_question_not_supported() -> None:
    request = _make_question_request()
    session = ACPSession("session-1", _QuestionCLI(request), _FakeConn())  # type: ignore[arg-type]

    response = await session.prompt([acp.text_block("hello")])

    assert response.stop_reason == "end_turn"
    assert request.resolved
    with pytest.raises(QuestionNotSupported):
        await request.wait()
