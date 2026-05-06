"""Snapshot tests for Anthropic chat provider."""

import json

import pytest
import respx
from common import B64_PNG, COMMON_CASES, Case, make_anthropic_response, run_test_cases
from httpx import Response
from inline_snapshot import snapshot

pytest.importorskip("anthropic", reason="Optional contrib dependency not installed")

from kosong.contrib.chat_provider.anthropic import Anthropic
from kosong.message import ImageURLPart, Message, TextPart, ThinkPart

TEST_CASES: dict[str, Case] = {
    **COMMON_CASES,
    "assistant_with_thinking": {
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="Let me think...", encrypted="sig_abc123"),
                    TextPart(text="The answer is 4."),
                ],
            ),
            Message(role="user", content="Thanks!"),
        ],
    },
    "thinking_without_signature_stripped": {
        "history": [
            Message(role="user", content="Hi"),
            Message(
                role="assistant",
                content=[ThinkPart(think="Thinking..."), TextPart(text="Hello!")],
            ),
            Message(role="user", content="Bye"),
        ],
    },
    "base64_image": {
        "history": [
            Message(
                role="user",
                content=[
                    TextPart(text="Describe:"),
                    ImageURLPart(
                        image_url=ImageURLPart.ImageURL(url=f"data:image/png;base64,{B64_PNG}")
                    ),
                ],
            )
        ],
    },
    "redacted_thinking": {
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="", encrypted="enc_redacted_sig_xyz"),
                    TextPart(text="4."),
                ],
            ),
            Message(role="user", content="Thanks!"),
        ],
    },
}


async def test_anthropic_message_conversion():
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        )
        results = await run_test_cases(mock, provider, TEST_CASES, ("messages", "system", "tools"))

        assert results == snapshot(
            {
                "simple_user_message": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Hello!",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        }
                    ],
                    "system": [
                        {
                            "type": "text",
                            "text": "You are helpful.",
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                    "tools": [],
                },
                "multi_turn_conversation": {
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": "What is 2+2?"}]},
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "2+2 equals 4."}],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "And 3+3?",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "tools": [],
                },
                "multi_turn_with_system": {
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": "What is 2+2?"}]},
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "2+2 equals 4."}],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "And 3+3?",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "system": [
                        {
                            "text": "You are a math tutor.",
                            "type": "text",
                            "cache_control": {"type": "ephemeral"},
                        }
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
                                    "type": "image",
                                    "source": {
                                        "type": "url",
                                        "url": "https://example.com/image.png",
                                    },
                                    "cache_control": {"type": "ephemeral"},
                                },
                            ],
                        }
                    ],
                    "tools": [],
                },
                "tool_definition": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Add 2 and 3",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        }
                    ],
                    "tools": [
                        {
                            "name": "add",
                            "description": "Add two integers.",
                            "input_schema": {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "integer", "description": "First number"},
                                    "b": {"type": "integer", "description": "Second number"},
                                },
                                "required": ["a", "b"],
                            },
                        },
                        {
                            "name": "multiply",
                            "description": "Multiply two integers.",
                            "input_schema": {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "integer", "description": "First number"},
                                    "b": {"type": "integer", "description": "Second number"},
                                },
                                "required": ["a", "b"],
                            },
                            "cache_control": {"type": "ephemeral"},
                        },
                    ],
                },
                "tool_call_with_image": {
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": "Add 2 and 3"}]},
                        {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "I'll add those numbers for you."},
                                {
                                    "type": "tool_use",
                                    "id": "call_abc123",
                                    "name": "add",
                                    "input": {"a": 2, "b": 3},
                                },
                            ],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "call_abc123",
                                    "content": [
                                        {"type": "text", "text": "5"},
                                        {
                                            "type": "image",
                                            "source": {
                                                "type": "url",
                                                "url": "https://example.com/image.png",
                                            },
                                        },
                                    ],
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "tools": [],
                },
                "tool_call": {
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": "Add 2 and 3"}]},
                        {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "I'll add those numbers for you."},
                                {
                                    "type": "tool_use",
                                    "id": "call_abc123",
                                    "name": "add",
                                    "input": {"a": 2, "b": 3},
                                },
                            ],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "call_abc123",
                                    "content": [{"type": "text", "text": "5"}],
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "tools": [],
                },
                "parallel_tool_calls": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "Calculate 2+3 and 4*5"}],
                        },
                        {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "I'll calculate both."},
                                {
                                    "type": "tool_use",
                                    "id": "call_add",
                                    "name": "add",
                                    "input": {"a": 2, "b": 3},
                                },
                                {
                                    "type": "tool_use",
                                    "id": "call_mul",
                                    "name": "multiply",
                                    "input": {"a": 4, "b": 5},
                                },
                            ],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "call_add",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "<system-reminder>This is a system reminder"
                                            "</system-reminder>",
                                        },
                                        {"type": "text", "text": "5"},
                                    ],
                                },
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "call_mul",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "<system-reminder>This is a system reminder"
                                            "</system-reminder>",
                                        },
                                        {"type": "text", "text": "20"},
                                    ],
                                    "cache_control": {"type": "ephemeral"},
                                },
                            ],
                        },
                    ],
                    "tools": [
                        {
                            "name": "add",
                            "description": "Add two integers.",
                            "input_schema": {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "integer", "description": "First number"},
                                    "b": {"type": "integer", "description": "Second number"},
                                },
                                "required": ["a", "b"],
                            },
                        },
                        {
                            "name": "multiply",
                            "description": "Multiply two integers.",
                            "input_schema": {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "integer", "description": "First number"},
                                    "b": {"type": "integer", "description": "Second number"},
                                },
                                "required": ["a", "b"],
                            },
                            "cache_control": {"type": "ephemeral"},
                        },
                    ],
                },
                "assistant_with_thinking": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "What is 2+2?"}],
                        },
                        {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "thinking",
                                    "thinking": "Let me think...",
                                    "signature": "sig_abc123",
                                },
                                {"type": "text", "text": "The answer is 4."},
                            ],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Thanks!",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "tools": [],
                },
                "thinking_without_signature_stripped": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "Hi"}],
                        },
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "Hello!"}],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Bye",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "tools": [],
                },
                "base64_image": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "Describe:"},
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "data": B64_PNG,
                                        "media_type": "image/png",
                                    },
                                    "cache_control": {"type": "ephemeral"},
                                },
                            ],
                        }
                    ],
                    "tools": [],
                },
                "redacted_thinking": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "What is 2+2?"}],
                        },
                        {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "thinking",
                                    "thinking": "",
                                    "signature": "enc_redacted_sig_xyz",
                                },
                                {"type": "text", "text": "4."},
                            ],
                        },
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Thanks!",
                                    "cache_control": {"type": "ephemeral"},
                                }
                            ],
                        },
                    ],
                    "tools": [],
                },
            }
        )


async def test_anthropic_generation_kwargs():
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_generation_kwargs(temperature=0.7, top_p=0.9, max_tokens=2048)
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert (body["temperature"], body["top_p"], body["max_tokens"]) == snapshot(
            (0.7, 0.9, 2048)
        )


async def test_anthropic_with_thinking():
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled", "budget_tokens": 32000})


async def test_anthropic_opus_46_adaptive_thinking():
    """Opus 4.6 adaptive thinking should opt-in to summarized display and pass effort."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-6-20260205",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "adaptive", "display": "summarized"})
        assert body["output_config"] == snapshot({"effort": "high"})
        # Adaptive thinking should not include interleaved-thinking beta header
        beta_header = mock.calls.last.request.headers.get("anthropic-beta", "")
        assert "interleaved-thinking-2025-05-14" not in beta_header


async def test_anthropic_opus_46_thinking_off():
    """Opus 4.6 with thinking off should send disabled and omit output_config."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-6-20260205",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("off")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "disabled"})
        assert "output_config" not in body


async def test_anthropic_opus_47_adaptive_thinking():
    """Opus 4.7 must use adaptive thinking (legacy rejected by API)."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-7",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "adaptive", "display": "summarized"})
        assert body["output_config"] == snapshot({"effort": "high"})


async def test_anthropic_opus_47_effort_low_passthrough():
    """Opus 4.7 with 'low' effort must not silently become 'high'."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-7",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("low")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["output_config"] == snapshot({"effort": "low"})


async def test_anthropic_opus_47_effort_medium_passthrough():
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-7",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("medium")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["output_config"] == snapshot({"effort": "medium"})


async def test_anthropic_future_opus_48_uses_adaptive():
    """A future Opus 4.8 model should be recognized as adaptive-capable via regex extrapolation."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-8",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "adaptive", "display": "summarized"})


async def test_anthropic_sonnet_4_legacy_thinking_preserved():
    """Sonnet 4 (pre-4.6) uses budget_tokens and does NOT send output_config.

    Per Anthropic docs, only Mythos/Opus 4.7/4.6/Sonnet 4.6/Opus 4.5 are
    explicitly listed as supporting the effort parameter. Sonnet 4 is not
    on that list, so emitting `output_config.effort` would risk a 400.
    """
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("low")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled", "budget_tokens": 1024})
        assert "output_config" not in body


async def test_anthropic_claude_3_legacy_no_output_config():
    """Claude 3.x predates the effort parameter — output_config must be absent
    to avoid 400 validation errors on those models.
    """
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-3-5-sonnet-20240620",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled", "budget_tokens": 32000})
        assert "output_config" not in body


async def test_anthropic_haiku_45_legacy_no_output_config():
    """Haiku 4.5 is not in the explicit effort-supporting list — be conservative."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-haiku-4-5-20251001",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("medium")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled", "budget_tokens": 4096})
        assert "output_config" not in body


async def test_anthropic_opus_45_legacy_xhigh_clamps_to_high():
    """Opus 4.5 is explicitly listed as supporting effort alongside legacy
    budget_tokens thinking. xhigh clamps to high for this model.
    """
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-5",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("xhigh")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "enabled", "budget_tokens": 32000})
        assert body["output_config"] == snapshot({"effort": "high"})


async def test_anthropic_opus_47_xhigh():
    """Opus 4.7 + xhigh should pass xhigh through (Opus 4.7-specific level)."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-7",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("xhigh")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "adaptive", "display": "summarized"})
        assert body["output_config"] == snapshot({"effort": "xhigh"})


async def test_anthropic_opus_47_max():
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-7",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("max")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["output_config"] == snapshot({"effort": "max"})


async def test_anthropic_opus_46_max():
    """Opus 4.6 supports max effort."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-6",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("max")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["output_config"] == snapshot({"effort": "max"})


async def test_anthropic_opus_46_xhigh_clamps_to_high():
    """Opus 4.6 doesn't support xhigh (Opus 4.7-only) — must clamp to high."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-opus-4-6",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking("xhigh")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["output_config"] == snapshot({"effort": "high"})


async def test_anthropic_switching_from_adaptive_to_off_clears_output_config():
    """Switching from adaptive effort to off must not leave a stale output_config."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = (
            Anthropic(
                model="claude-opus-4-7",
                api_key="test-key",
                default_max_tokens=1024,
                stream=False,
            )
            .with_thinking("high")
            .with_thinking("off")
        )
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["thinking"] == snapshot({"type": "disabled"})
        assert "output_config" not in body


async def test_anthropic_metadata():
    """Metadata should be forwarded to the Anthropic API request."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
            metadata={"user_id": "test-session-id"},
        )
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["metadata"] == snapshot({"user_id": "test-session-id"})


async def test_anthropic_metadata_omitted_when_none():
    """Metadata should not be included in the request when not provided."""
    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        )
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert "metadata" not in body


async def test_anthropic_opus_46_thinking_effort_property():
    """thinking_effort roundtrips through output_config.effort in adaptive mode."""
    for effort in ("low", "medium", "high", "off"):
        provider = Anthropic(
            model="claude-opus-4-6-20260205",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking(effort)  # type: ignore[arg-type]
        assert provider.thinking_effort == effort


async def test_anthropic_opus_47_thinking_effort_property():
    """Opus 4.7 roundtrips all effort levels through output_config."""
    for effort in ("low", "medium", "high", "xhigh", "max", "off"):
        provider = Anthropic(
            model="claude-opus-4-7",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        ).with_thinking(effort)  # type: ignore[arg-type]
        assert provider.thinking_effort == effort


async def test_anthropic_opus_46_xhigh_property_reflects_clamped_value():
    """After clamping, the getter reports the effective (clamped) effort."""
    provider = Anthropic(
        model="claude-opus-4-6",
        api_key="test-key",
        default_max_tokens=1024,
        stream=False,
    ).with_thinking("xhigh")
    # xhigh clamped to high for 4.6
    assert provider.thinking_effort == "high"


async def test_anthropic_parallel_tool_results_merged_into_single_user_message():
    """Parallel tool results must be packed into a single user message.

    Per the Anthropic Messages API spec, every tool_use block in an assistant
    message must be answered by tool_result blocks inside the same (single)
    user message. Anthropic's official backend leniently merges consecutive
    same-role turns, but strict Anthropic-compatible backends (e.g. DeepSeek's
    /anthropic endpoint) reject the split form with 400 — and the docs warn
    that the split form also silently teaches Claude to avoid parallel calls.
    """
    from common import ADD_TOOL, MUL_TOOL, capture_request

    from kosong.message import ToolCall

    history = [
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
                    function=ToolCall.FunctionBody(name="multiply", arguments='{"a": 4, "b": 5}'),
                ),
            ],
        ),
        Message(role="tool", content="5", tool_call_id="call_add"),
        Message(role="tool", content="20", tool_call_id="call_mul"),
    ]

    with respx.mock(base_url="https://api.anthropic.com") as mock:
        mock.post("/v1/messages").mock(return_value=Response(200, json=make_anthropic_response()))
        provider = Anthropic(
            model="claude-sonnet-4-20250514",
            api_key="test-key",
            default_max_tokens=1024,
            stream=False,
        )
        body = await capture_request(mock, provider, "", [ADD_TOOL, MUL_TOOL], history)

    messages = body["messages"]
    # Expected wire layout:
    #   [0] user      — original question
    #   [1] assistant — text + two tool_use blocks
    #   [2] user      — *both* tool_result blocks packed together
    assert [m["role"] for m in messages] == ["user", "assistant", "user"], (
        f"Parallel tool results should collapse into one trailing user message, "
        f"got roles: {[m['role'] for m in messages]}"
    )
    tool_results = [b for b in messages[-1]["content"] if b["type"] == "tool_result"]
    assert {b["tool_use_id"] for b in tool_results} == {"call_add", "call_mul"}
