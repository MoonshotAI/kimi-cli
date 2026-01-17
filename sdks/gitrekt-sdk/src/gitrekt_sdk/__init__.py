"""
Gitrekt SDK provides a convenient way to access the Gitrekt API and build agent workflows.

Key features:

- `generate` creates a completion stream and merges message parts into a `Message`
  with optional `TokenUsage`.
- `step` layers tool dispatch over `generate`, returning `StepResult` and tool outputs.
- Message structures, content parts, and tool abstractions live in this module.

Example (minimal agent loop):

```python
import asyncio

from gitrekt_sdk import Gitrekt, Message, SimpleToolset, StepResult, ToolResult, step


def tool_result_to_message(result: ToolResult) -> Message:
    return Message(
        role="tool",
        tool_call_id=result.tool_call_id,
        content=result.return_value.output,
    )


async def agent_loop() -> None:
    gitrekt = Gitrekt(
        base_url="https://api.moonshot.ai/v1",
        api_key="your_gitrekt_api_key_here",
        model="kimi-k2-turbo-preview",
    )

    toolset = SimpleToolset()
    history: list[Message] = []
    system_prompt = "You are a helpful assistant."

    while True:
        user_input = input("You: ").strip()
        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit"}:
            break

        history.append(Message(role="user", content=user_input))

        while True:
            result: StepResult = await step(
                chat_provider=gitrekt,
                system_prompt=system_prompt,
                toolset=toolset,
                history=history,
            )

            history.append(result.message)
            tool_results = await result.tool_results()
            for tool_result in tool_results:
                history.append(tool_result_to_message(tool_result))

            if text := result.message.extract_text():
                print("Assistant:", text)

            if not result.tool_calls:
                break


asyncio.run(agent_loop())
```
"""

from __future__ import annotations

from kosong import GenerateResult, StepResult, generate, step
from kosong.chat_provider import (
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.chat_provider.kimi import Kimi as Gitrekt
from kosong.chat_provider.kimi import KimiStreamedMessage as GitrektStreamedMessage
from kosong.message import (
    AudioURLPart,
    ContentPart,
    ImageURLPart,
    Message,
    Role,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
    VideoURLPart,
)
from kosong.tooling import (
    BriefDisplayBlock,
    CallableTool,
    CallableTool2,
    DisplayBlock,
    Tool,
    ToolError,
    ToolOk,
    ToolResult,
    ToolResultFuture,
    ToolReturnValue,
    Toolset,
    UnknownDisplayBlock,
)
from kosong.tooling.simple import SimpleToolset

__all__ = [
    # providers
    "Gitrekt",
    "GitrektStreamedMessage",
    "StreamedMessagePart",
    "ThinkingEffort",
    # provider errors
    "APIConnectionError",
    "APIEmptyResponseError",
    "APIStatusError",
    "APITimeoutError",
    "ChatProviderError",
    # messages and content parts
    "Message",
    "Role",
    "ContentPart",
    "TextPart",
    "ThinkPart",
    "ImageURLPart",
    "AudioURLPart",
    "VideoURLPart",
    "ToolCall",
    "ToolCallPart",
    # tooling
    "Tool",
    "CallableTool",
    "CallableTool2",
    "Toolset",
    "SimpleToolset",
    "ToolReturnValue",
    "ToolOk",
    "ToolError",
    "ToolResult",
    "ToolResultFuture",
    # display blocks
    "DisplayBlock",
    "BriefDisplayBlock",
    "UnknownDisplayBlock",
    # generation
    "generate",
    "step",
    "GenerateResult",
    "StepResult",
    "TokenUsage",
]
