"""
Kosong is an LLM abstraction layer designed for modern AI agent applications.
It unifies message structures, asynchronous tool orchestration, and pluggable chat providers so you
can build agents with ease and avoid vendor lock-in.

Key features:

- `kosong.generate` creates a completion stream and merges streamed message parts (including
  content and tool calls) from any `ChatProvider` into a complete `Message` plus optional
  `TokenUsage`.
- `kosong.step` layers tool dispatch (`Tool`, `Toolset`, `SimpleToolset`) over `generate`,
  exposing `StepResult` with awaited tool outputs and streaming callbacks.
- Message structures and tool abstractions live under `kosong.message` and `kosong.tooling`.

Example:

```python
import asyncio

from pydantic import BaseModel

import kosong
from kosong import StepResult
from kosong.chat_provider.kimi import Kimi
from kosong.message import Message
from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from kosong.tooling.simple import SimpleToolset


class AddToolParams(BaseModel):
    a: int
    b: int


class AddTool(CallableTool2[AddToolParams]):
    name: str = "add"
    description: str = "Add two integers."
    params: type[AddToolParams] = AddToolParams

    async def __call__(self, params: AddToolParams) -> ToolReturnValue:
        return ToolOk(output=str(params.a + params.b))


async def main() -> None:
    kimi = Kimi(
        base_url="https://api.moonshot.ai/v1",
        api_key="your_kimi_api_key_here",
        model="kimi-k2-turbo-preview",
    )

    toolset = SimpleToolset()
    toolset += AddTool()

    history = [
        Message(role="user", content="Please add 2 and 3 with the add tool."),
    ]

    result: StepResult = await kosong.step(
        chat_provider=kimi,
        system_prompt="You are a precise math tutor.",
        toolset=toolset,
        history=history,
    )
    print(result.message)
    print(await result.tool_results())


asyncio.run(main())
```
"""

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from loguru import logger

from kosong._generate import GenerateResult, generate
from kosong.chat_provider import ChatProvider, ChatProviderError, StreamedMessagePart, TokenUsage
from kosong.message import Message, ToolCall
from kosong.tooling import ToolResult, ToolResultFuture, Toolset
from kosong.utils.aio import Callback

# Explicitly import submodules
from . import chat_provider, contrib, message, tooling, utils

logger.disable("kosong")

__all__ = [
    # submodules
    "chat_provider",
    "tooling",
    "message",
    "utils",
    "contrib",
    # classes and functions
    "generate",
    "GenerateResult",
    "step",
    "StepResult",
]


async def step(
    chat_provider: ChatProvider,
    system_prompt: str,
    toolset: Toolset,
    history: Sequence[Message],
    *,
    on_message_part: Callback[[StreamedMessagePart], None] | None = None,
    on_tool_result: Callable[[ToolResult], None] | None = None,
) -> "StepResult":
    """
    Run one agent "step". In one step, the function generates LLM response based on the given
    context for exactly one time. All new message parts will be streamed to `on_message_part` in
    real-time if provided. Tool calls will be handled by `toolset`. The generated message will be
    returned in a `StepResult`. Depending on the toolset implementation, the tool calls may be
    handled asynchronously and the results need to be fetched with `await result.tool_results()`.

    The message history will NOT be modified in this function.

    The token usage will be returned in the `StepResult` if available.

    Raises:
        APIConnectionError: If the API connection fails.
        APITimeoutError: If the API request times out.
        APIStatusError: If the API returns a status code of 4xx or 5xx.
        APIEmptyResponseError: If the API returns an empty response.
        ChatProviderError: If any other recognized chat provider error occurs.
        asyncio.CancelledError: If the step is cancelled.
    """

    tool_calls: list[ToolCall] = []
    tool_result_futures: dict[str, ToolResultFuture] = {}

    def future_done_callback(future: ToolResultFuture):
        if on_tool_result:
            try:
                result = future.result()
                on_tool_result(result)
            except asyncio.CancelledError:
                return

    async def on_tool_call(tool_call: ToolCall):
        tool_calls.append(tool_call)
        result = toolset.handle(tool_call)

        if isinstance(result, ToolResult):
            future = ToolResultFuture()
            future.add_done_callback(future_done_callback)
            future.set_result(result)
            tool_result_futures[tool_call.id] = future
        else:
            result.add_done_callback(future_done_callback)
            tool_result_futures[tool_call.id] = result

    try:
        result = await generate(
            chat_provider,
            system_prompt,
            toolset.tools,
            history,
            on_message_part=on_message_part,
            on_tool_call=on_tool_call,
        )
    except (ChatProviderError, asyncio.CancelledError):
        # cancel all the futures to avoid hanging tasks
        for future in tool_result_futures.values():
            future.remove_done_callback(future_done_callback)
            future.cancel()
        await asyncio.gather(*tool_result_futures.values(), return_exceptions=True)
        raise

    return StepResult(
        result.id,
        result.message,
        result.usage,
        tool_calls,
        tool_result_futures,
    )


@dataclass(frozen=True, slots=True)
class StepResult:
    id: str | None
    """The ID of the generated message."""

    message: Message
    """The message generated in this step."""

    usage: TokenUsage | None
    """The token usage in this step."""

    tool_calls: list[ToolCall]
    """All the tool calls generated in this step."""

    _tool_result_futures: dict[str, ToolResultFuture]
    """@private The futures of the results of the spawned tool calls."""

    async def tool_results(self) -> list[ToolResult]:
        """All the tool results returned by corresponding tool calls."""
        if not self._tool_result_futures:
            return []

        try:
            results: list[ToolResult] = []
            for tool_call in self.tool_calls:
                future = self._tool_result_futures[tool_call.id]
                result = await future
                results.append(result)
            return results
        finally:
            # one exception should cancel all the futures to avoid hanging tasks
            for future in self._tool_result_futures.values():
                future.cancel()
            await asyncio.gather(*self._tool_result_futures.values(), return_exceptions=True)
