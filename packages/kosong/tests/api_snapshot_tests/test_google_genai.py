"""Snapshot tests for Google GenAI (Gemini) chat provider."""

import json
from typing import Any

import pytest
import respx
from common import COMMON_CASES, Case, run_test_cases
from httpx import Response
from inline_snapshot import snapshot

pytest.importorskip("google.genai", reason="Optional contrib dependency not installed")

from kosong.contrib.chat_provider.google_genai import GoogleGenAI
from kosong.message import Message, TextPart, ToolCall


def make_response() -> dict[str, Any]:
    return {
        "candidates": [
            {
                "content": {"parts": [{"text": "Hello"}], "role": "model"},
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 5,
            "totalTokenCount": 15,
        },
        "modelVersion": "gemini-2.5-flash",
    }


TEST_CASES: dict[str, Case] = {
    # Google GenAI doesn't support image_url in the same way, use subset of common cases
    **{k: v for k, v in COMMON_CASES.items() if "image" not in k},
    "tool_call_with_thought_signature": {
        "history": [
            Message(role="user", content="Add 2 and 3"),
            Message(
                role="assistant",
                content=[TextPart(text="I'll add those.")],
                tool_calls=[
                    ToolCall(
                        id="add_call_sig",
                        function=ToolCall.FunctionBody(name="add", arguments='{"a": 2, "b": 3}'),
                        extras={"thought_signature_b64": "dGhvdWdodF9zaWduYXR1cmVfZGF0YQ=="},
                    )
                ],
            ),
        ],
    },
}


@pytest.mark.asyncio
async def test_google_genai_message_conversion():
    with respx.mock(base_url="https://generativelanguage.googleapis.com") as mock:
        mock.route(method="POST", path__regex=r"/v1beta/models/.+:generateContent").mock(
            return_value=Response(200, json=make_response())
        )
        provider = GoogleGenAI(model="gemini-2.5-flash", api_key="test-key", stream=False)
        results = await run_test_cases(
            mock, provider, TEST_CASES, ("contents", "systemInstruction", "tools")
        )

        assert results == snapshot(
            {
                "simple_user_message": {
                    "contents": [{"parts": [{"text": "Hello!"}], "role": "user"}],
                    "systemInstruction": {
                        "parts": [{"text": "You are helpful."}],
                        "role": "user",
                    },
                },
                "multi_turn_conversation": {
                    "contents": [
                        {"parts": [{"text": "What is 2+2?"}], "role": "user"},
                        {"parts": [{"text": "2+2 equals 4."}], "role": "model"},
                        {"parts": [{"text": "And 3+3?"}], "role": "user"},
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                },
                "multi_turn_with_system": {
                    "contents": [
                        {"parts": [{"text": "What is 2+2?"}], "role": "user"},
                        {"parts": [{"text": "2+2 equals 4."}], "role": "model"},
                        {"parts": [{"text": "And 3+3?"}], "role": "user"},
                    ],
                    "systemInstruction": {
                        "parts": [{"text": "You are a math tutor."}],
                        "role": "user",
                    },
                },
                "tool_definition": {
                    "contents": [{"parts": [{"text": "Add 2 and 3"}], "role": "user"}],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                    "tools": [
                        {
                            "functionDeclarations": [
                                {
                                    "name": "add",
                                    "description": "Add two integers.",
                                    "parameters": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "a": {
                                                "type": "INTEGER",
                                                "description": "First number",
                                            },
                                            "b": {
                                                "type": "INTEGER",
                                                "description": "Second number",
                                            },
                                        },
                                        "required": ["a", "b"],
                                    },
                                },
                                {
                                    "description": "Multiply two integers.",
                                    "name": "multiply",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                            ]
                        }
                    ],
                },
                "tool_call": {
                    "contents": [
                        {"parts": [{"text": "Add 2 and 3"}], "role": "user"},
                        {
                            "parts": [
                                {"text": "I'll add those numbers for you."},
                                {
                                    "functionCall": {
                                        "id": "call_abc123",
                                        "args": {"a": 2, "b": 3},
                                        "name": "add",
                                    }
                                },
                            ],
                            "role": "model",
                        },
                        {
                            "parts": [
                                {
                                    "functionResponse": {
                                        "parts": [],
                                        "id": "call_abc123",
                                        "name": "add",
                                        "response": {"output": "5"},
                                    }
                                }
                            ],
                            "role": "user",
                        },
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                },
                "parallel_tool_calls": {
                    "contents": [
                        {"parts": [{"text": "Calculate 2+3 and 4*5"}], "role": "user"},
                        {
                            "parts": [
                                {"text": "I'll calculate both."},
                                {
                                    "functionCall": {
                                        "id": "call_add",
                                        "name": "add",
                                        "args": {"a": 2, "b": 3},
                                    }
                                },
                                {
                                    "functionCall": {
                                        "id": "call_mul",
                                        "name": "multiply",
                                        "args": {"a": 4, "b": 5},
                                    }
                                },
                            ],
                            "role": "model",
                        },
                        {
                            "parts": [
                                {
                                    "functionResponse": {
                                        "parts": [],
                                        "id": "call_add",
                                        "name": "add",
                                        "response": {
                                            "output": "<system-reminder>This is a system reminder"
                                            "</system-reminder>5"
                                        },
                                    }
                                },
                                {
                                    "functionResponse": {
                                        "parts": [],
                                        "id": "call_mul",
                                        "name": "multiply",
                                        "response": {
                                            "output": "<system-reminder>This is a system reminder"
                                            "</system-reminder>20"
                                        },
                                    }
                                },
                            ],
                            "role": "user",
                        },
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                    "tools": [
                        {
                            "functionDeclarations": [
                                {
                                    "description": "Add two integers.",
                                    "name": "add",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                                {
                                    "description": "Multiply two integers.",
                                    "name": "multiply",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                            ]
                        }
                    ],
                },
                "tool_call_with_thought_signature": {
                    "contents": [
                        {"parts": [{"text": "Add 2 and 3"}], "role": "user"},
                        {
                            "parts": [
                                {"text": "I'll add those."},
                                {
                                    "functionCall": {
                                        "id": "add_call_sig",
                                        "name": "add",
                                        "args": {"a": 2, "b": 3},
                                    },
                                    "thoughtSignature": "dGhvdWdodF9zaWduYXR1cmVfZGF0YQ==",
                                },
                            ],
                            "role": "model",
                        },
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                },
            }
        )


@pytest.mark.asyncio
async def test_google_genai_vertexai_message_conversion():
    with respx.mock(base_url="https://aiplatform.googleapis.com") as mock:
        mock.route(
            method="POST",
            path__regex=r"/v1beta1/publishers/google/models/gemini-3-pro-preview:generateContent",
        ).mock(return_value=Response(200, json=make_response()))
        provider = GoogleGenAI(
            model="gemini-3-pro-preview",
            api_key="test-key",
            stream=False,
            vertexai=True,
        )
        results = await run_test_cases(
            mock, provider, TEST_CASES, ("contents", "systemInstruction", "tools")
        )
        assert results == snapshot(
            {
                "simple_user_message": {
                    "contents": [{"parts": [{"text": "Hello!"}], "role": "user"}],
                    "systemInstruction": {"parts": [{"text": "You are helpful."}], "role": "user"},
                },
                "multi_turn_conversation": {
                    "contents": [
                        {"parts": [{"text": "What is 2+2?"}], "role": "user"},
                        {"parts": [{"text": "2+2 equals 4."}], "role": "model"},
                        {"parts": [{"text": "And 3+3?"}], "role": "user"},
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                },
                "multi_turn_with_system": {
                    "contents": [
                        {"parts": [{"text": "What is 2+2?"}], "role": "user"},
                        {"parts": [{"text": "2+2 equals 4."}], "role": "model"},
                        {"parts": [{"text": "And 3+3?"}], "role": "user"},
                    ],
                    "systemInstruction": {
                        "parts": [{"text": "You are a math tutor."}],
                        "role": "user",
                    },
                },
                "tool_definition": {
                    "contents": [{"parts": [{"text": "Add 2 and 3"}], "role": "user"}],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                    "tools": [
                        {
                            "functionDeclarations": [
                                {
                                    "description": "Add two integers.",
                                    "name": "add",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                                {
                                    "description": "Multiply two integers.",
                                    "name": "multiply",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                            ]
                        }
                    ],
                },
                "tool_call": {
                    "contents": [
                        {"parts": [{"text": "Add 2 and 3"}], "role": "user"},
                        {
                            "parts": [
                                {"text": "I'll add those numbers for you."},
                                {
                                    "function_call": {
                                        "id": "call_abc123",
                                        "args": {"a": 2, "b": 3},
                                        "name": "add",
                                    }
                                },
                            ],
                            "role": "model",
                        },
                        {
                            "parts": [
                                {
                                    "function_response": {
                                        "parts": [],
                                        "id": "call_abc123",
                                        "name": "add",
                                        "response": {"output": "5"},
                                    }
                                }
                            ],
                            "role": "user",
                        },
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                },
                "parallel_tool_calls": {
                    "contents": [
                        {"parts": [{"text": "Calculate 2+3 and 4*5"}], "role": "user"},
                        {
                            "parts": [
                                {"text": "I'll calculate both."},
                                {
                                    "function_call": {
                                        "id": "call_add",
                                        "args": {"a": 2, "b": 3},
                                        "name": "add",
                                    }
                                },
                                {
                                    "function_call": {
                                        "id": "call_mul",
                                        "args": {"a": 4, "b": 5},
                                        "name": "multiply",
                                    }
                                },
                            ],
                            "role": "model",
                        },
                        {
                            "parts": [
                                {
                                    "function_response": {
                                        "parts": [],
                                        "id": "call_add",
                                        "name": "add",
                                        "response": {
                                            "output": "<system-reminder>This is a system reminder</system-reminder>5"  # noqa: E501
                                        },
                                    }
                                },
                                {
                                    "function_response": {
                                        "parts": [],
                                        "id": "call_mul",
                                        "name": "multiply",
                                        "response": {
                                            "output": "<system-reminder>This is a system reminder</system-reminder>20"  # noqa: E501
                                        },
                                    }
                                },
                            ],
                            "role": "user",
                        },
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                    "tools": [
                        {
                            "functionDeclarations": [
                                {
                                    "description": "Add two integers.",
                                    "name": "add",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                                {
                                    "description": "Multiply two integers.",
                                    "name": "multiply",
                                    "parameters": {
                                        "properties": {
                                            "a": {"description": "First number", "type": "INTEGER"},
                                            "b": {
                                                "description": "Second number",
                                                "type": "INTEGER",
                                            },
                                        },
                                        "required": ["a", "b"],
                                        "type": "OBJECT",
                                    },
                                },
                            ]
                        }
                    ],
                },
                "tool_call_with_thought_signature": {
                    "contents": [
                        {"parts": [{"text": "Add 2 and 3"}], "role": "user"},
                        {
                            "parts": [
                                {"text": "I'll add those."},
                                {
                                    "function_call": {
                                        "id": "add_call_sig",
                                        "args": {"a": 2, "b": 3},
                                        "name": "add",
                                    },
                                    "thought_signature": "dGhvdWdodF9zaWduYXR1cmVfZGF0YQ==",
                                },
                            ],
                            "role": "model",
                        },
                    ],
                    "systemInstruction": {"parts": [{"text": ""}], "role": "user"},
                },
            }
        )


@pytest.mark.asyncio
async def test_google_genai_generation_kwargs():
    with respx.mock(base_url="https://generativelanguage.googleapis.com") as mock:
        mock.route(method="POST", path__regex=r"/v1beta/models/.+:generateContent").mock(
            return_value=Response(200, json=make_response())
        )
        provider = GoogleGenAI(
            model="gemini-2.5-flash", api_key="test-key", stream=False
        ).with_generation_kwargs(temperature=0.7, max_output_tokens=2048)
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        config = body.get("generationConfig", {})
        assert (config.get("temperature"), config.get("maxOutputTokens")) == snapshot((0.7, 2048))


@pytest.mark.asyncio
async def test_google_genai_with_thinking():
    with respx.mock(base_url="https://generativelanguage.googleapis.com") as mock:
        mock.route(method="POST", path__regex=r"/v1beta/models/.+:generateContent").mock(
            return_value=Response(200, json=make_response())
        )
        provider = GoogleGenAI(
            model="gemini-2.5-flash", api_key="test-key", stream=False
        ).with_thinking("high")
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body.get("generationConfig", {}).get("thinkingConfig") == snapshot(
            {"include_thoughts": True, "thinking_budget": 32000}
        )
