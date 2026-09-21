"""Snapshot tests for Kimi chat provider."""

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
import respx
from common import COMMON_CASES, Case, make_chat_completion_response, run_test_cases
from httpx import Response
from inline_snapshot import snapshot
from openai.types.chat import ChatCompletion, ChatCompletionChunk

from kosong.chat_provider import ThinkingEffort
from kosong.chat_provider.kimi import Kimi, KimiStreamedMessage
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
    "assistant_with_empty_reasoning": {
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think=""),
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
                "assistant_with_empty_reasoning": {
                    "messages": [
                        {"role": "user", "content": "What is 2+2?"},
                        {
                            "role": "assistant",
                            "content": "The answer is 4.",
                            "reasoning_content": "",
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
        assert (body["temperature"], body["max_completion_tokens"]) == snapshot((0.7, 2048))


async def test_kimi_default_omits_completion_cap():
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert "max_tokens" not in body
        assert "max_completion_tokens" not in body


async def test_kimi_max_tokens_alias_preserves_explicit_none():
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = (
            Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
            .with_generation_kwargs(max_tokens=2048)
            .with_generation_kwargs(max_tokens=None)
        )
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())

        assert provider.model_parameters["max_completion_tokens"] is None
        assert "max_tokens" not in body
        assert "max_completion_tokens" not in body


def test_kimi_max_tokens_alias_defers_to_canonical_key():
    provider = Kimi(
        model="kimi-k2-turbo-preview", api_key="test-key", stream=False
    ).with_generation_kwargs(max_tokens=2048, max_completion_tokens=None)

    assert provider.model_parameters["max_completion_tokens"] is None


async def test_kimi_generation_overrides_per_call():
    """Per-call ``generation_overrides`` reach the request body without mutating the provider."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(
            model="kimi-k2-turbo-preview", api_key="test-key", stream=False
        ).with_generation_kwargs(temperature=0.7)
        stream = await provider.generate(
            "",
            [],
            [Message(role="user", content="Hi")],
            generation_overrides={"max_completion_tokens": 4096},
        )
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert (body["temperature"], body["max_completion_tokens"]) == snapshot((0.7, 4096))
        # The override must not have leaked into the provider's persistent kwargs.
        assert "max_completion_tokens" not in provider.model_parameters


async def test_kimi_generation_overrides_normalize_max_tokens_alias():
    """An override key ``max_tokens`` is normalized to ``max_completion_tokens``."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)
        stream = await provider.generate(
            "",
            [],
            [Message(role="user", content="Hi")],
            generation_overrides={"max_tokens": 2048},
        )
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["max_completion_tokens"] == 2048
        assert "max_tokens" not in body


async def test_kimi_generation_overrides_take_precedence_over_provider_kwargs():
    """Per-call override beats the provider-level value for the same key."""
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(
            model="kimi-k2-turbo-preview", api_key="test-key", stream=False
        ).with_generation_kwargs(max_completion_tokens=8000)
        stream = await provider.generate(
            "",
            [],
            [Message(role="user", content="Hi")],
            generation_overrides={"max_completion_tokens": 1024},
        )
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["max_completion_tokens"] == 1024
        # Provider-level kwargs are unchanged after the call.
        assert provider.model_parameters["max_completion_tokens"] == 8000


@pytest.mark.parametrize(
    ("effort", "expected_type"),
    [
        ("off", "disabled"),
        ("low", "enabled"),
        ("medium", "enabled"),
        ("high", "enabled"),
        ("xhigh", "enabled"),
        ("max", "enabled"),
    ],
)
async def test_kimi_with_thinking_omits_legacy_reasoning_effort(
    effort: ThinkingEffort,
    expected_type: str,
):
    with respx.mock(base_url="https://api.moonshot.ai") as mock:
        mock.post("/v1/chat/completions").mock(
            return_value=Response(200, json=make_chat_completion_response())
        )
        provider = Kimi(
            model="kimi-k2-turbo-preview", api_key="test-key", stream=False
        ).with_thinking(effort)
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert "reasoning_effort" not in body
        assert body["thinking"] == {"type": expected_type}
        assert provider.thinking_effort == effort


def test_kimi_thinking_effort_preserves_caller_value_without_mapping():
    provider = Kimi(model="kimi-k2-turbo-preview", api_key="test-key", stream=False)

    assert provider.thinking_effort is None
    for configured, expected in (
        (provider.with_thinking("off"), "off"),
        (provider.with_thinking("low"), "low"),
        (provider.with_thinking("medium"), "medium"),
        (provider.with_thinking("high"), "high"),
        (provider.with_thinking("xhigh"), "xhigh"),
        (provider.with_thinking("max"), "max"),
    ):
        assert configured.thinking_effort == expected
        assert "reasoning_effort" not in configured.model_parameters


def test_kimi_explicit_legacy_reasoning_effort_is_independent_from_thinking_state():
    provider = Kimi(
        model="kimi-k2-turbo-preview", api_key="test-key", stream=False
    ).with_generation_kwargs(reasoning_effort="medium")

    assert provider.thinking_effort is None
    assert provider.model_parameters["reasoning_effort"] == "medium"

    configured = provider.with_thinking("high")
    assert configured.thinking_effort == "high"
    assert configured.model_parameters["reasoning_effort"] == "medium"

    updated_legacy = configured.with_generation_kwargs(reasoning_effort="low")
    assert updated_legacy.thinking_effort == "high"
    assert updated_legacy.model_parameters["reasoning_effort"] == "low"


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


def _make_chunk(delta: dict[str, Any], finish_reason: str | None = None) -> ChatCompletionChunk:
    return ChatCompletionChunk.model_validate(
        {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "kimi-k2-thinking",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
    )


async def test_kimi_stream_preserves_empty_reasoning_delta():
    """An empty-string ``reasoning_content`` delta means "reasoned but
    empty", not "no reasoning" — it must surface as a ThinkPart so the
    distinction round-trips to the server: preserved-thinking backends
    require reasoning_content on every assistant message, and the stored
    ThinkPart (even empty) is what makes _convert_message emit the field."""
    chunks = [
        _make_chunk({"reasoning_content": ""}),
        _make_chunk(
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "Shell_2",
                        "type": "function",
                        "function": {"name": "Shell", "arguments": "{}"},
                    }
                ]
            },
            finish_reason="stop",
        ),
    ]

    async def _aiter() -> AsyncIterator[ChatCompletionChunk]:
        for chunk in chunks:
            yield chunk

    stream = KimiStreamedMessage(_aiter())  # type: ignore[arg-type]
    parts = [part async for part in stream]
    assert parts[0] == ThinkPart(think="")
    assert isinstance(parts[1], ToolCall)


async def test_kimi_non_stream_preserves_empty_reasoning_content():
    """Same distinction for the non-streaming path: ``reasoning_content: \"\"``
    on the response message must yield an (empty) ThinkPart."""
    response = ChatCompletion.model_validate(
        {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "kimi-k2-thinking",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Done.",
                        "reasoning_content": "",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    )
    stream = KimiStreamedMessage(response)
    parts = [part async for part in stream]
    assert parts[0] == ThinkPart(think="")
    assert parts[1] == TextPart(text="Done.")


async def test_kimi_absent_reasoning_field_still_yields_no_thinkpart():
    """A delta WITHOUT the reasoning_content field is the genuinely
    reason-free case and must NOT fabricate a ThinkPart — the empty vs
    absent distinction is exactly what preserved thinking relies on."""
    chunks = [
        _make_chunk({"content": "Done."}, finish_reason="stop"),
    ]

    async def _aiter() -> AsyncIterator[ChatCompletionChunk]:
        for chunk in chunks:
            yield chunk

    stream = KimiStreamedMessage(_aiter())  # type: ignore[arg-type]
    parts = [part async for part in stream]
    assert parts == [TextPart(text="Done.")]
