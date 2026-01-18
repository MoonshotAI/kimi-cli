"""Common test cases and utilities for snapshot tests."""

import json
from collections.abc import Sequence
from typing import Any, TypedDict

import respx

from kosong.chat_provider import ChatProvider
from kosong.message import ImageURLPart, Message, TextPart, ToolCall
from kosong.tooling import Tool

__all__ = [
    "ADD_TOOL",
    "B64_PNG",
    "COMMON_CASES",
    "MUL_TOOL",
    "capture_request",
    "make_anthropic_response",
    "make_chat_completion_response",
    "run_test_cases",
]


def make_anthropic_response(model: str = "claude-sonnet-4-20250514") -> dict[str, Any]:
    """Common response for Anthropic Messages API."""
    return {
        "id": "msg_test_123",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": "Hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }


def make_chat_completion_response(model: str = "test-model") -> dict[str, Any]:
    """Common response for OpenAI-compatible chat completion APIs."""
    return {
        "id": "chatcmpl-test123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


B64_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"
    "DUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

ADD_TOOL = Tool(
    name="add",
    description="Add two integers.",
    parameters={
        "type": "object",
        "properties": {
            "a": {"type": "integer", "description": "First number"},
            "b": {"type": "integer", "description": "Second number"},
        },
        "required": ["a", "b"],
    },
)

MUL_TOOL = Tool(
    name="multiply",
    description="Multiply two integers.",
    parameters={
        "type": "object",
        "properties": {
            "a": {"type": "integer", "description": "First number"},
            "b": {"type": "integer", "description": "Second number"},
        },
        "required": ["a", "b"],
    },
)


class Case(TypedDict, total=False):
    """A test case for chat providers."""

    system: str
    """The system prompt."""
    tools: list[Tool]
    """The list of tools."""
    history: list[Message]
    """The message history."""


# Common test cases shared across providers
COMMON_CASES: dict[str, Case] = {
    "simple_user_message": {
        "system": "You are helpful.",
        "history": [Message(role="user", content="Hello!")],
    },
    "multi_turn_conversation": {
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(role="assistant", content="2+2 equals 4."),
            Message(role="user", content="And 3+3?"),
        ],
    },
    "multi_turn_with_system": {
        "system": "You are a math tutor.",
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(role="assistant", content="2+2 equals 4."),
            Message(role="user", content="And 3+3?"),
        ],
    },
    "image_url": {
        "history": [
            Message(
                role="user",
                content=[
                    TextPart(text="What's in this image?"),
                    ImageURLPart(
                        image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")
                    ),
                ],
            )
        ],
    },
    "tool_definition": {
        "history": [Message(role="user", content="Add 2 and 3")],
        "tools": [ADD_TOOL, MUL_TOOL],
    },
    "tool_call": {
        "history": [
            Message(role="user", content="Add 2 and 3"),
            Message(
                role="assistant",
                content="I'll add those numbers for you.",
                tool_calls=[
                    ToolCall(
                        id="call_abc123",
                        function=ToolCall.FunctionBody(name="add", arguments='{"a": 2, "b": 3}'),
                    )
                ],
            ),
            Message(role="tool", content="5", tool_call_id="call_abc123"),
        ],
    },
    "tool_call_with_image": {
        "history": [
            Message(role="user", content="Add 2 and 3"),
            Message(
                role="assistant",
                content="I'll add those numbers for you.",
                tool_calls=[
                    ToolCall(
                        id="call_abc123",
                        function=ToolCall.FunctionBody(name="add", arguments='{"a": 2, "b": 3}'),
                    )
                ],
            ),
            Message(
                role="tool",
                content=[
                    TextPart(text="5"),
                    ImageURLPart(
                        image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")
                    ),
                ],
                tool_call_id="call_abc123",
            ),
        ],
    },
    "parallel_tool_calls": {
        "tools": [ADD_TOOL, MUL_TOOL],
        "history": [
            Message(role="user", content="Calculate 2+3 and 4*5"),
            Message(
                role="assistant",
                content="I'll calculate both.",
                tool_calls=[
                    ToolCall(
                        id="call_add",
                        function=ToolCall.FunctionBody(name="add", arguments='{"a": 2, "b": 3}'),
                    ),
                    ToolCall(
                        id="call_mul",
                        function=ToolCall.FunctionBody(
                            name="multiply", arguments='{"a": 4, "b": 5}'
                        ),
                    ),
                ],
            ),
            Message(
                role="tool",
                content=[
                    TextPart(text="<system-reminder>This is a system reminder</system-reminder>"),
                    TextPart(text="5"),
                ],
                tool_call_id="call_add",
            ),
            Message(
                role="tool",
                content=[
                    TextPart(text="<system-reminder>This is a system reminder</system-reminder>"),
                    TextPart(text="20"),
                ],
                tool_call_id="call_mul",
            ),
        ],
    },
}


async def capture_request(
    mock: respx.MockRouter,
    provider: ChatProvider,
    system: str,
    tools: Sequence[Tool],
    history: list[Message],
) -> dict[str, Any]:
    """Generate and capture the request body."""
    stream = await provider.generate(system, tools, history)
    async for _ in stream:
        pass
    request = mock.calls.last.request
    assert request.content is not None
    return json.loads(request.content.decode())


async def run_test_cases(
    mock: respx.MockRouter,
    provider: ChatProvider,
    cases: dict[str, Case],
    extract_keys: tuple[str, ...],
) -> dict[str, dict[str, Any]]:
    """Run all test cases and return results dict for snapshot comparison."""
    results: dict[str, dict[str, Any]] = {}
    for name, case in cases.items():
        body = await capture_request(
            mock,
            provider,
            case.get("system", ""),
            case.get("tools", []),
            case.get("history", []),
        )
        results[name] = {k: v for k, v in body.items() if k in extract_keys}
    return results
