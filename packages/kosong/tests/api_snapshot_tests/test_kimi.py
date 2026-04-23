"""Snapshot tests for Kimi chat provider."""

import json

import respx
from common import COMMON_CASES, Case, make_chat_completion_response, run_test_cases
from httpx import Response
from inline_snapshot import snapshot

from kosong.chat_provider.kimi import Kimi
from kosong.message import Message, TextPart, ThinkPart, ToolCall
from kosong.tooling import Tool

BUILTIN_TOOL = Tool(
    name="$web_search",
    description="Search the web",
    parameters={"type": "object", "properties": {}},
)

TEST_CASES: dict[str, Case] = {
    **COMMON_CASES,
    "builtin_tool": {
        "history": [Message(role="user", content="Search for something")],
        "tools": [BUILTIN_TOOL],
    },
    "assistant_with_reasoning": {
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="Let me think..."),
                    TextPart(text="The answer is 4."),
                ],
            ),
            Message(role="user", content="Thanks!"),
        ],
    },
    "assistant_tool_call_without_text": {
        "history": [
            Message(role="user", content="Call the add tool"),
            Message(
                role="assistant",
                content=[],
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
    "assistant_tool_call_with_reasoning_only": {
        "history": [
            Message(role="user", content="Think and call the add tool"),
            Message(
                role="assistant",
                content=[ThinkPart(think="I should call the tool.")],
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
}


async def test_kimi_message_conversion():
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response("kimi-k2"))
        )
        provider = Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
        results = await run_test_cases(mock, provider, TEST_CASES, ("messages", "tools"))

        assert results == snapshot(
            {
                "simple_user_message": {
                    "messages": [
                        {"role": "system", "content": "You are helpful."},
                        {"role": "user", "content": "Hello!"},
                    ],
                    "tools": [],
                },
                "multi_turn_conversation": {
                    "messages": [
                        {"role": "user", "content": "What is 2+2?"},
                        {"role": "assistant", "content": "2+2 equals 4."},
                        {"role": "user", "content": "And 3+3?"},
                    ],
                    "tools": [],
                },
                "multi_turn_with_system": {
                    "messages": [
                        {"role": "system", "content": "You are a math tutor."},
                        {"role": "user", "content": "What is 2+2?"},
                        {"role": "assistant", "content": "2+2 equals 4."},
                        {"role": "user", "content": "And 3+3?"},
                    ],
                    "tools": [],
                },
                "image_url": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "What's in this image?"},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": "https://example.com/image.png",
                                        "id": None,
                                    },
                                },
                            ],
                        }
                    ],
                    "tools": [],
                },
                "tool_definition": {
                    "messages": [{"role": "user", "content": "Add 2 and 3"}],
                    "tools": [
                        {
                            "type": "function",
                            "function": {
                                "name": "add",
                                "description": "Add two integers.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "a": {
                                            "type": "integer",
                                            "description": "First number",
                                        },
                                        "b": {
                                            "type": "integer",
                                            "description": "Second number",
                                        },
                                    },
                                    "required": ["a", "b"],
                                },
                            },
                        },
                        {
                            "type": "function",
                            "function": {
                                "name": "multiply",
                                "description": "Multiply two integers.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "a": {"type": "integer", "description": "First number"},
                                        "b": {"type": "integer", "description": "Second number"},
                                    },
                                    "required": ["a", "b"],
                                },
                            },
                        },
                    ],
                },
                "tool_call_with_image": {
                    "messages": [
                        {"role": "user", "content": "Add 2 and 3"},
                        {
                            "role": "assistant",
                            "content": "I'll add those numbers for you.",
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "id": "call_abc123",
                                    "function": {"name": "add", "arguments": '{"a": 2, "b": 3}'},
                                }
                            ],
                        },
                        {
                            "role": "tool",
                            "content": [
                                {"type": "text", "text": "5"},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": "https://example.com/image.png",
                                        "id": None,
                                    },
                                },
                            ],
                            "tool_call_id": "call_abc123",
                        },
                    ],
                    "tools": [],
                },
                "tool_call": {
                    "messages": [
                        {"role": "user", "content": "Add 2 and 3"},
                        {
                            "role": "assistant",
                            "content": "I'll add those numbers for you.",
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "id": "call_abc123",
                                    "function": {"name": "add", "arguments": '{"a": 2, "b": 3}'},
                                }
                            ],
                        },
                        {"role": "tool", "content": "5", "tool_call_id": "call_abc123"},
                    ],
                    "tools": [],
                },
                "parallel_tool_calls": {
                    "messages": [
                        {"role": "user", "content": "Calculate 2+3 and 4*5"},
                        {
                            "role": "assistant",
                            "content": "I'll calculate both.",
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "id": "call_add",
                                    "function": {
                                        "name": "add",
                                        "arguments": '{"a": 2, "b": 3}',
                                    },
                                },
                                {
                                    "type": "function",
                                    "id": "call_mul",
                                    "function": {
                                        "name": "multiply",
                                        "arguments": '{"a": 4, "b": 5}',
                                    },
                                },
                            ],
                        },
                        {
                            "role": "tool",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "<system-reminder>This is a system reminder"
                                    "</system-reminder>",
                                },
                                {"type": "text", "text": "5"},
                            ],
                            "tool_call_id": "call_add",
                        },
                        {
                            "role": "tool",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "<system-reminder>This is a system reminder"
                                    "</system-reminder>",
                                },
                                {"type": "text", "text": "20"},
                            ],
                            "tool_call_id": "call_mul",
                        },
                    ],
                    "tools": [
                        {
                            "type": "function",
                            "function": {
                                "name": "add",
                                "description": "Add two integers.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "a": {"type": "integer", "description": "First number"},
                                        "b": {"type": "integer", "description": "Second number"},
                                    },
                                    "required": ["a", "b"],
                                },
                            },
                        },
                        {
                            "type": "function",
                            "function": {
                                "name": "multiply",
                                "description": "Multiply two integers.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "a": {"type": "integer", "description": "First number"},
                                        "b": {"type": "integer", "description": "Second number"},
                                    },
                                    "required": ["a", "b"],
                                },
                            },
                        },
                    ],
                },
                "builtin_tool": {
                    "messages": [{"role": "user", "content": "Search for something"}],
                    "tools": [
                        {
                            "type": "builtin_function",
                            "function": {"name": "$web_search"},
                        }
                    ],
                },
                "assistant_with_reasoning": {
                    "messages": [
                        {"role": "user", "content": "What is 2+2?"},
                        {
                            "role": "assistant",
                            "content": "The answer is 4.",
                            "reasoning_content": "Let me think...",
                        },
                        {"role": "user", "content": "Thanks!"},
                    ],
                    "tools": [],
                },
                "assistant_tool_call_without_text": {
                    "messages": [
                        {"role": "user", "content": "Call the add tool"},
                        {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "id": "call_abc123",
                                    "function": {"name": "add", "arguments": '{"a": 2, "b": 3}'},
                                }
                            ],
                        },
                        {"role": "tool", "content": "5", "tool_call_id": "call_abc123"},
                    ],
                    "tools": [],
                },
                "assistant_tool_call_with_reasoning_only": {
                    "messages": [
                        {"role": "user", "content": "Think and call the add tool"},
                        {
                            "role": "assistant",
                            "reasoning_content": "I should call the tool.",
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "id": "call_abc123",
                                    "function": {"name": "add", "arguments": '{"a": 2, "b": 3}'},
                                }
                            ],
                        },
                        {"role": "tool", "content": "5", "tool_call_id": "call_abc123"},
                    ],
                    "tools": [],
                },
            }
        )


async def test_kimi_generation_kwargs():
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(
            model="kimi-k2-turbo-preview", api_key="test-key", stream=False
        ).with_generation_kwargs(temperature=0.7, max_tokens=2048)
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert (body["temperature"], body["max_tokens"]) == snapshot((0.7, 2048))


async def test_kimi_with_thinking():
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(
            model="kimi-k2-turbo-preview", api_key="test-key", stream=False
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["reasoning_effort"] == snapshot("high")


async def test_kimi_with_extra_body_thinking_deep_merge():
    """with_extra_body must deep-merge the ``thinking`` sub-dict so that
    a later call adding ``thinking.keep`` does not erase ``thinking.type``
    set by an earlier ``with_thinking`` call."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = (
            Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
            .with_thinking("high")
            .with_extra_body({"thinking": {"keep": "all"}})
        )
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled", "keep": "all"})


async def test_kimi_with_extra_body_thinking_empty_dict_is_noop():
    """Passing ``{"thinking": {}}`` must leave an earlier ``thinking.type``
    intact. An empty ``thinking`` patch is a no-op, not a clearing signal."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = (
            Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
            .with_thinking("high")
            .with_extra_body({"thinking": {}})
        )
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled"})


async def test_kimi_with_extra_body_thinking_starts_from_empty_dict():
    """Seeding ``thinking`` with ``{}`` first, then populating it via
    ``with_thinking`` must produce the populated config — the empty seed
    must not block subsequent field additions."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = (
            Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
            .with_extra_body({"thinking": {}})
            .with_thinking("high")
        )
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled"})


async def test_kimi_with_extra_body_non_thinking_key_shallow_merge():
    """Only the ``thinking`` key gets deep-merge special-casing; other
    top-level extra_body keys still follow the previous shallow-merge
    semantics (last writer wins)."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = (
            Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
            .with_extra_body({"custom": {"a": 1}})  # pyright: ignore[reportArgumentType]
            .with_extra_body({"custom": {"b": 2}})  # pyright: ignore[reportArgumentType]
        )
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["custom"] == snapshot({"b": 2})
