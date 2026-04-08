"""Tests for graceful recovery when stream breaks after complete ToolCalls."""

import asyncio
from collections.abc import AsyncIterator, Sequence
from typing import Self

import pytest

from kosong import generate, step
from kosong.chat_provider import (
    APIConnectionError,
    ChatProviderError,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.message import Message, TextPart, ToolCall, ToolCallPart
from kosong.tooling import CallableTool, ParametersType, Tool, ToolOk, ToolReturnValue
from kosong.tooling.simple import SimpleToolset


class ErrorAfterToolCallStream:
    """A stream that yields parts normally, then raises after a complete ToolCall."""

    def __init__(
        self,
        parts: list[StreamedMessagePart],
        error: ChatProviderError,
    ):
        self._parts = parts
        self._error = error
        self._index = 0

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        if self._index < len(self._parts):
            part = self._parts[self._index]
            self._index += 1
            return part
        raise self._error

    @property
    def id(self) -> str | None:
        return "partial-stream"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class ErrorAfterToolCallProvider:
    """Provider that streams parts, then raises an error."""

    name = "error-after-toolcall"

    def __init__(
        self,
        parts: list[StreamedMessagePart],
        error: ChatProviderError,
    ):
        self._parts = parts
        self._error = error

    @property
    def model_name(self) -> str:
        return "error-after-toolcall"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> ErrorAfterToolCallStream:
        return ErrorAfterToolCallStream(self._parts, self._error)

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


# ---------------------------------------------------------------------------
# Test: generate() should recover partial results when stream breaks after
# a complete ToolCall
# ---------------------------------------------------------------------------


class TestGeneratePartialRecovery:
    """Test that generate() recovers when stream breaks after complete ToolCalls."""

    def test_recover_when_stream_breaks_after_complete_tool_call(self):
        """Stream: TextPart + ToolCall, then connection error.

        The ToolCall has a complete name and arguments. generate() should
        return the partial result instead of raising.
        """
        tool_call = ToolCall(
            id="tc-1",
            function=ToolCall.FunctionBody(name="SetTodoList", arguments='{"todos": []}'),
        )
        parts: list[StreamedMessagePart] = [
            TextPart(text="Let me update the todo list."),
            tool_call,
        ]
        error = APIConnectionError("Connection reset by peer")

        result = asyncio.run(
            generate(
                ErrorAfterToolCallProvider(parts, error),
                system_prompt="",
                tools=[],
                history=[],
            )
        )
        assert result.message.content == [TextPart(text="Let me update the todo list.")]
        assert result.message.tool_calls == [tool_call]
        assert result.usage is None  # usage was not received

    def test_recover_with_pending_complete_tool_call(self):
        """Stream: TextPart + ToolCall + ToolCallParts, then error.

        The ToolCall has accumulated complete arguments via ToolCallParts
        before the stream breaks. Should recover.
        """
        parts: list[StreamedMessagePart] = [
            TextPart(text="Updating..."),
            ToolCall(
                id="tc-1",
                function=ToolCall.FunctionBody(name="WriteFile", arguments=None),
            ),
            ToolCallPart(arguments_part='{"path":'),
            ToolCallPart(arguments_part=' "test.txt"}'),
        ]
        error = APIConnectionError("Connection closed")

        result = asyncio.run(
            generate(
                ErrorAfterToolCallProvider(parts, error),
                system_prompt="",
                tools=[],
                history=[],
            )
        )
        assert result.message.tool_calls is not None
        assert len(result.message.tool_calls) == 1
        tc = result.message.tool_calls[0]
        assert tc.function.name == "WriteFile"
        assert tc.function.arguments == '{"path": "test.txt"}'

    def test_no_recovery_when_only_text_received(self):
        """Stream: only TextPart, then error. Should still raise."""
        parts: list[StreamedMessagePart] = [
            TextPart(text="I will help you with..."),
        ]
        error = APIConnectionError("Connection reset")

        with pytest.raises(APIConnectionError):
            asyncio.run(
                generate(
                    ErrorAfterToolCallProvider(parts, error),
                    system_prompt="",
                    tools=[],
                    history=[],
                )
            )

    def test_no_recovery_when_tool_call_arguments_truncated(self):
        """Stream: ToolCall + partial ToolCallParts with truncated JSON. Should raise.

        When the stream breaks mid-argument-transfer, the accumulated arguments
        are malformed JSON (e.g. '{"path":'). Recovery should NOT happen because
        the ToolCall is incomplete.
        """
        parts: list[StreamedMessagePart] = [
            ToolCall(
                id="tc-1",
                function=ToolCall.FunctionBody(name="WriteFile", arguments=None),
            ),
            ToolCallPart(arguments_part='{"path":'),
            # stream breaks here — arguments = '{"path":' (invalid JSON)
        ]
        error = APIConnectionError("Connection reset")

        with pytest.raises(APIConnectionError):
            asyncio.run(
                generate(
                    ErrorAfterToolCallProvider(parts, error),
                    system_prompt="",
                    tools=[],
                    history=[],
                )
            )

    def test_no_recovery_when_tool_call_has_no_name(self):
        """Stream: ToolCallPart without a preceding ToolCall name. Should raise."""
        parts: list[StreamedMessagePart] = [
            TextPart(text="working..."),
            ToolCallPart(arguments_part='{"a": 1}'),
        ]
        error = APIConnectionError("Connection reset")

        with pytest.raises(APIConnectionError):
            asyncio.run(
                generate(
                    ErrorAfterToolCallProvider(parts, error),
                    system_prompt="",
                    tools=[],
                    history=[],
                )
            )

    def test_no_recovery_on_empty_stream(self):
        """Stream: no parts at all before error. Should raise."""
        error = APIConnectionError("Connection refused")

        with pytest.raises(APIConnectionError):
            asyncio.run(
                generate(
                    ErrorAfterToolCallProvider([], error),
                    system_prompt="",
                    tools=[],
                    history=[],
                )
            )

    def test_recover_multiple_tool_calls(self):
        """Stream: two complete ToolCalls, then error. Both should be recovered."""
        parts: list[StreamedMessagePart] = [
            ToolCall(
                id="tc-1",
                function=ToolCall.FunctionBody(name="ReadFile", arguments='{"path": "a.py"}'),
            ),
            ToolCall(
                id="tc-2",
                function=ToolCall.FunctionBody(name="ReadFile", arguments='{"path": "b.py"}'),
            ),
        ]
        error = APIConnectionError("Connection reset")

        result = asyncio.run(
            generate(
                ErrorAfterToolCallProvider(parts, error),
                system_prompt="",
                tools=[],
                history=[],
            )
        )
        assert result.message.tool_calls is not None
        assert len(result.message.tool_calls) == 2

    def test_recover_when_tool_call_arguments_empty_string(self):
        """Stream: ToolCall with arguments="" then error. Should recover.

        Empty string arguments are treated as valid no-arg calls by the
        downstream execution path (simple.py uses `arguments or "{}"`).
        """
        tool_call = ToolCall(
            id="tc-1",
            function=ToolCall.FunctionBody(name="GetStatus", arguments=""),
        )
        parts: list[StreamedMessagePart] = [tool_call]
        error = APIConnectionError("Connection reset")

        result = asyncio.run(
            generate(
                ErrorAfterToolCallProvider(parts, error),
                system_prompt="",
                tools=[],
                history=[],
            )
        )
        assert result.message.tool_calls == [tool_call]

    def test_no_recovery_when_first_complete_second_truncated(self):
        """Stream: first ToolCall complete, second ToolCall with truncated arguments.

        _has_complete_tool_calls requires ALL tool calls to have valid JSON.
        Even though the first is fine, the second is truncated, so recovery
        should NOT happen.
        """
        parts: list[StreamedMessagePart] = [
            ToolCall(
                id="tc-1",
                function=ToolCall.FunctionBody(name="ReadFile", arguments='{"path": "a.py"}'),
            ),
            ToolCall(
                id="tc-2",
                function=ToolCall.FunctionBody(name="WriteFile", arguments=None),
            ),
            ToolCallPart(arguments_part='{"path":'),
            # stream breaks here — tc-2 arguments = '{"path":' (invalid JSON)
        ]
        error = APIConnectionError("Connection reset")

        with pytest.raises(APIConnectionError):
            asyncio.run(
                generate(
                    ErrorAfterToolCallProvider(parts, error),
                    system_prompt="",
                    tools=[],
                    history=[],
                )
            )


class TestStepPartialRecovery:
    """Test that step() also recovers and dispatches tools on partial stream recovery."""

    def test_step_dispatches_tools_on_partial_recovery(self):
        """When generate() recovers with a complete ToolCall, step() should
        dispatch the tool and return results normally."""

        class EchoTool(CallableTool):
            name: str = "echo"
            description: str = "Echo tool"
            parameters: ParametersType = {
                "type": "object",
                "properties": {"msg": {"type": "string"}},
            }

            async def __call__(self, msg: str = "") -> ToolReturnValue:
                return ToolOk(output=f"echo: {msg}")

        tool_call = ToolCall(
            id="tc-1",
            function=ToolCall.FunctionBody(name="echo", arguments='{"msg": "hello"}'),
        )
        parts: list[StreamedMessagePart] = [
            TextPart(text="Calling echo..."),
            tool_call,
        ]
        error = APIConnectionError("Connection reset")
        provider = ErrorAfterToolCallProvider(parts, error)
        toolset = SimpleToolset([EchoTool()])

        collected_parts: list[StreamedMessagePart] = []

        def on_message_part(part: StreamedMessagePart):
            collected_parts.append(part)

        async def run():
            result = await step(
                provider,
                system_prompt="",
                toolset=toolset,
                history=[],
                on_message_part=on_message_part,
            )
            return result, await result.tool_results()

        step_result, tool_results = asyncio.run(run())
        assert step_result.tool_calls == [tool_call]
        assert len(tool_results) == 1
        assert tool_results[0].return_value.output == "echo: hello"
