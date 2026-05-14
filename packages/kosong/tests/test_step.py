import asyncio
import copy
from collections.abc import AsyncIterator, Sequence
from typing import Self, override

import pytest

from kosong import StepCancelled, step
from kosong._generate import GenerateCancelled, generate
from kosong.chat_provider import (
    ChatProvider,
    StreamedMessage,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.chat_provider.mock import MockChatProvider
from kosong.message import Message, TextPart, ThinkPart, ToolCall
from kosong.tooling import CallableTool, ParametersType, Tool, ToolOk, ToolResult, ToolReturnValue
from kosong.tooling.simple import SimpleToolset


def test_step():
    class PlusTool(CallableTool):
        name: str = "plus"
        description: str = "This is a plus tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"},
            },
        }

        @override
        async def __call__(self, a: int, b: int) -> ToolReturnValue:
            return ToolOk(output=str(a + b))

    plus_tool_call = ToolCall(
        id="plus#123",
        function=ToolCall.FunctionBody(name="plus", arguments='{"a": 1, "b": 2}'),
    )
    input_parts: list[StreamedMessagePart] = [
        TextPart(text="Hello, world!"),
        plus_tool_call,
    ]
    chat_provider = MockChatProvider(message_parts=input_parts)
    toolset = SimpleToolset([PlusTool()])

    output_parts: list[StreamedMessagePart] = []
    collected_tool_results: list[ToolResult] = []

    def on_message_part(part: StreamedMessagePart):
        output_parts.append(part)

    def on_tool_result(result: ToolResult):
        collected_tool_results.append(result)

    async def run():
        step_result = await step(
            chat_provider,
            system_prompt="",
            toolset=toolset,
            history=[],
            on_message_part=on_message_part,
            on_tool_result=on_tool_result,
        )
        tool_results = await step_result.tool_results()
        return step_result, tool_results

    step_result, tool_results = asyncio.run(run())
    assert step_result.message.content == [TextPart(text="Hello, world!")]
    assert step_result.tool_calls == [plus_tool_call]
    assert output_parts == input_parts
    assert tool_results == [ToolResult(tool_call_id="plus#123", return_value=ToolOk(output="3"))]
    assert collected_tool_results == tool_results


class _BlockingStreamedMessage(StreamedMessage):
    """Streams predetermined parts then blocks forever on the next __anext__.

    Used to deterministically reproduce the "user pressed ESC after the model
    streamed some content but before the stream ended" scenario.  The blocking
    point can be released by setting ``parts_emitted``.
    """

    def __init__(
        self,
        parts: list[StreamedMessagePart],
        parts_emitted: asyncio.Event,
    ):
        self._parts = parts
        self._idx = 0
        self._parts_emitted = parts_emitted

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        if self._idx < len(self._parts):
            part = self._parts[self._idx]
            self._idx += 1
            if self._idx == len(self._parts):
                self._parts_emitted.set()
            return part
        # parts exhausted — block until the test cancels us
        await asyncio.Event().wait()
        raise StopAsyncIteration  # pragma: no cover

    @property
    def id(self) -> str:
        return "blocking"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class _BlockingChatProvider(ChatProvider):
    """ChatProvider that streams predetermined parts then blocks indefinitely.

    Implements the Protocol directly so the ``generate`` return type doesn't
    have to match ``MockChatProvider``'s narrower ``MockStreamedMessage``.
    """

    name = "blocking-mock"

    def __init__(
        self,
        parts: list[StreamedMessagePart],
        parts_emitted: asyncio.Event,
    ):
        self._stream_parts = parts
        self._parts_emitted = parts_emitted

    @property
    def model_name(self) -> str:
        return "blocking-mock"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> _BlockingStreamedMessage:
        return _BlockingStreamedMessage(self._stream_parts, self._parts_emitted)

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return copy.copy(self)


@pytest.mark.asyncio
async def test_step_streaming_cancel_raises_step_cancelled_with_partial_result():
    """ESC during streaming after a complete tool_call must surface a partial
    StepResult so the caller can pair it with a synthetic tool_result.
    """
    tool_call = ToolCall(
        id="plus#abc",
        function=ToolCall.FunctionBody(name="plus", arguments='{"a": 1, "b": 2}'),
    )
    parts: list[StreamedMessagePart] = [
        ThinkPart(think="planning to add..."),
        TextPart(text="Let me add them."),
        tool_call,
    ]
    parts_emitted = asyncio.Event()

    class PlusTool(CallableTool):
        name: str = "plus"
        description: str = "Add two integers."
        parameters: ParametersType = {
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"},
            },
        }

        @override
        async def __call__(self, a: int, b: int) -> ToolReturnValue:
            return ToolOk(output=str(a + b))

    toolset = SimpleToolset([PlusTool()])
    chat_provider = _BlockingChatProvider(parts, parts_emitted)

    step_task = asyncio.create_task(
        step(
            chat_provider,
            system_prompt="",
            toolset=toolset,
            history=[],
        )
    )

    # wait until the provider has streamed every part (including the tool_call)
    await asyncio.wait_for(parts_emitted.wait(), timeout=1.0)
    # one event-loop tick so step() can advance past the last yielded part
    await asyncio.sleep(0)
    step_task.cancel()

    with pytest.raises(StepCancelled) as exc_info:
        await step_task

    partial = exc_info.value.partial
    assert partial.id is None
    assert partial.usage is None
    # tool_calls in both the message and the partial result mirror what the
    # callbacks saw — the on_tool_call for `tool_call` did fire (it was the
    # last pending part and the stream was still emitting), so the future
    # exists in _tool_result_futures.
    assert partial.message.tool_calls is not None
    visible_ids = {tc.id for tc in partial.message.tool_calls}
    assert tool_call.id in visible_ids
    assert {tc.id for tc in partial.tool_calls} == visible_ids
    # The completed-before-cancel tool may still have a future entry; the
    # caller decides how to handle it (await, cancel, synthesize).
    futures = partial._tool_result_futures  # pyright: ignore[reportPrivateUsage]
    assert set(futures.keys()) <= visible_ids


@pytest.mark.asyncio
async def test_step_streaming_cancel_preserves_thinking_only_partial():
    """ESC mid-thinking (no tool_call yet, no text) should still yield a
    partial result.  Whether the caller persists it is its decision.
    """
    parts: list[StreamedMessagePart] = [
        ThinkPart(think="hmm, considering..."),
    ]
    parts_emitted = asyncio.Event()

    chat_provider = _BlockingChatProvider(parts, parts_emitted)
    toolset = SimpleToolset()

    step_task = asyncio.create_task(
        step(
            chat_provider,
            system_prompt="",
            toolset=toolset,
            history=[],
        )
    )
    await asyncio.wait_for(parts_emitted.wait(), timeout=1.0)
    await asyncio.sleep(0)
    step_task.cancel()

    with pytest.raises(StepCancelled) as exc_info:
        await step_task

    partial = exc_info.value.partial
    assert partial.tool_calls == []
    # ThinkPart was the pending part — best-effort flush on cancel
    assert any(isinstance(p, ThinkPart) for p in partial.message.content)


@pytest.mark.asyncio
async def test_generate_cancel_during_on_tool_call_does_not_duplicate_pending():
    """Cancellation arriving while awaiting ``on_tool_call`` must NOT leave
    duplicate tool_calls in the partial message.

    Reproduces the race: between ``_message_append(pending_part)`` and the
    next-iteration's ``pending_part = part`` reassignment, the only thing
    keeping the previous pending alive is an ``await callback(on_tool_call,
    pending_part)``.  If a CancelledError is delivered at that yield point,
    the except-handler sees the same ``pending_part`` and — without the fix —
    appends it again, producing two assistant tool_calls with the same id.

    Driven through ``generate()`` directly so we can install a custom
    ``on_tool_call`` that genuinely awaits and yields control to the event
    loop.  Through ``step()`` the on_tool_call closure is synchronous and the
    race is harder to provoke deterministically.
    """
    tool_call_a = ToolCall(
        id="tc#a",
        function=ToolCall.FunctionBody(name="t", arguments="{}"),
    )
    # Force tool_call_a out of pending by following it with an unmergeable part.
    text_after = TextPart(text="follow-up")
    parts: list[StreamedMessagePart] = [tool_call_a, text_after]
    parts_emitted = asyncio.Event()

    chat_provider = _BlockingChatProvider(parts, parts_emitted)
    on_tool_call_entered = asyncio.Event()

    async def slow_on_tool_call(_tc: ToolCall) -> None:
        on_tool_call_entered.set()
        # block forever — the test cancels us mid-await
        await asyncio.Event().wait()

    gen_task = asyncio.create_task(
        generate(
            chat_provider,
            system_prompt="",
            tools=[],
            history=[],
            on_tool_call=slow_on_tool_call,
        )
    )

    # wait until generate() is awaiting on_tool_call(tool_call_a)
    await asyncio.wait_for(on_tool_call_entered.wait(), timeout=1.0)
    gen_task.cancel()

    with pytest.raises(GenerateCancelled) as exc_info:
        await gen_task

    msg = exc_info.value.message
    assert msg.tool_calls is not None
    ids = [tc.id for tc in msg.tool_calls]
    # Without the fix this would be ["tc#a", "tc#a"].
    assert ids == [tool_call_a.id], (
        f"expected exactly one tool_call entry, got {ids} (duplicate would corrupt history)"
    )
    # The unmergeable follow-up text was the new pending part when cancel
    # hit; the except-handler's best-effort flush should include it.
    assert any(isinstance(p, TextPart) and p.text == "follow-up" for p in msg.content)
