"""Tests for the AskUserQuestion tool."""

from __future__ import annotations

import asyncio
import json

import pytest

from kimi_cli.soul import _current_wire
from kimi_cli.soul.toolset import current_tool_call
from kimi_cli.tools.ask_user import AskUserQuestion, Params, QuestionOptionParam, QuestionParam
from kimi_cli.wire import Wire
from kimi_cli.wire.types import QuestionNotSupported, QuestionRequest, ToolCall


@pytest.fixture
def ask_user_tool() -> AskUserQuestion:
    return AskUserQuestion()


def _make_params(
    question: str = "Which option?",
    options: list[tuple[str, str]] | None = None,
    multi_select: bool = False,
) -> Params:
    if options is None:
        options = [("Option A", "First option"), ("Option B", "Second option")]
    return Params(
        questions=[
            QuestionParam(
                question=question,
                header="Test",
                options=[QuestionOptionParam(label=lab, description=d) for lab, d in options],
                multi_select=multi_select,
            )
        ]
    )


async def test_ask_user_basic(ask_user_tool: AskUserQuestion):
    """Test normal question-answer flow."""
    wire = Wire()
    wire_token = _current_wire.set(wire)
    tool_call = ToolCall(
        id="tc-ask-1",
        function=ToolCall.FunctionBody(name="AskUserQuestion", arguments=None),
    )
    tc_token = current_tool_call.set(tool_call)

    try:
        params = _make_params()

        # Start the tool call in a task so we can intercept the QuestionRequest
        tool_task = asyncio.create_task(ask_user_tool(params))

        # Receive the QuestionRequest from the UI side of the wire
        ui_side = wire.ui_side(merge=False)
        msg = await asyncio.wait_for(ui_side.receive(), timeout=2.0)
        assert isinstance(msg, QuestionRequest)
        assert len(msg.questions) == 1
        assert msg.questions[0].question == "Which option?"
        assert msg.questions[0].options[0].label == "Option A"
        assert msg.questions[0].options[1].label == "Option B"
        assert msg.tool_call_id == "tc-ask-1"

        # Resolve the request with an answer
        msg.resolve({"Which option?": "Option A"})

        result = await asyncio.wait_for(tool_task, timeout=2.0)
        assert not result.is_error
        assert isinstance(result.output, str)
        parsed = json.loads(result.output)
        assert parsed == {"answers": {"Which option?": "Option A"}}
    finally:
        wire.shutdown()
        current_tool_call.reset(tc_token)
        _current_wire.reset(wire_token)


async def test_ask_user_dismissed(ask_user_tool: AskUserQuestion):
    """Test that user dismiss returns a non-error result with dismiss note."""
    wire = Wire()
    wire_token = _current_wire.set(wire)
    tool_call = ToolCall(
        id="tc-ask-dismiss",
        function=ToolCall.FunctionBody(name="AskUserQuestion", arguments=None),
    )
    tc_token = current_tool_call.set(tool_call)

    try:
        params = _make_params()
        tool_task = asyncio.create_task(ask_user_tool(params))

        ui_side = wire.ui_side(merge=False)
        msg = await asyncio.wait_for(ui_side.receive(), timeout=2.0)
        assert isinstance(msg, QuestionRequest)

        # Resolve with empty answers (simulating user dismiss)
        msg.resolve({})

        result = await asyncio.wait_for(tool_task, timeout=2.0)
        assert not result.is_error
        assert isinstance(result.output, str)
        parsed = json.loads(result.output)
        assert parsed["answers"] == {}
        assert "dismissed" in parsed.get("note", "").lower()
    finally:
        wire.shutdown()
        current_tool_call.reset(tc_token)
        _current_wire.reset(wire_token)


async def test_ask_user_client_unsupported(ask_user_tool: AskUserQuestion):
    """Test that QuestionNotSupported returns a hard error telling LLM not to retry."""
    wire = Wire()
    wire_token = _current_wire.set(wire)
    tool_call = ToolCall(
        id="tc-ask-unsupported",
        function=ToolCall.FunctionBody(name="AskUserQuestion", arguments=None),
    )
    tc_token = current_tool_call.set(tool_call)

    try:
        params = _make_params()
        tool_task = asyncio.create_task(ask_user_tool(params))

        ui_side = wire.ui_side(merge=False)
        msg = await asyncio.wait_for(ui_side.receive(), timeout=2.0)
        assert isinstance(msg, QuestionRequest)

        # Reject with QuestionNotSupported (simulating unsupported client)
        msg.set_exception(QuestionNotSupported())

        result = await asyncio.wait_for(tool_task, timeout=2.0)
        assert result.is_error
        assert "does not support" in result.message
        assert "Do NOT call this tool again" in result.message
    finally:
        wire.shutdown()
        current_tool_call.reset(tc_token)
        _current_wire.reset(wire_token)


async def test_ask_user_no_wire(ask_user_tool: AskUserQuestion):
    """Test that the tool returns an error when Wire is not available."""
    # Ensure no wire is set
    wire_token = _current_wire.set(None)
    tool_call = ToolCall(
        id="tc-ask-2",
        function=ToolCall.FunctionBody(name="AskUserQuestion", arguments=None),
    )
    tc_token = current_tool_call.set(tool_call)

    try:
        params = _make_params()
        result = await ask_user_tool(params)
        assert result.is_error
        assert "Wire" in result.message
    finally:
        current_tool_call.reset(tc_token)
        _current_wire.reset(wire_token)


async def test_ask_user_no_tool_call(ask_user_tool: AskUserQuestion):
    """Test that the tool returns an error when no tool_call context is set."""
    wire = Wire()
    wire_token = _current_wire.set(wire)
    # Do NOT set current_tool_call

    try:
        params = _make_params()
        result = await ask_user_tool(params)
        assert result.is_error
        assert "tool call" in result.message.lower() or "context" in result.message.lower()
    finally:
        wire.shutdown()
        _current_wire.reset(wire_token)
