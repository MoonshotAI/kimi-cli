"""Snapshot tests for OpenAI Responses API chat provider."""

import json
from typing import Any

import respx
from common import COMMON_CASES, Case, run_test_cases
from httpx import Response
from inline_snapshot import snapshot

from kosong.contrib.chat_provider.openai_responses import OpenAIResponses
from kosong.message import Message, TextPart, ThinkPart


def make_response() -> dict[str, Any]:
    return {
        "id": "resp_test123",
        "object": "response",
        "created_at": 1234567890,
        "status": "completed",
        "model": "gpt-4.1",
        "output": [
            {
                "type": "message",
                "id": "msg_test",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Hello", "annotations": []}],
            }
        ],
        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    }


TEST_CASES: dict[str, Case] = {
    **COMMON_CASES,
    "assistant_with_reasoning": {
        "history": [
            Message(role="user", content="What is 2+2?"),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="Thinking...", encrypted="enc_abc"),
                    TextPart(text="4."),
                ],
            ),
            Message(role="user", content="Thanks!"),
        ],
    },
}


async def test_openai_responses_message_conversion():
    with respx.mock(base_url="https://api.openai.com") as mock:
        mock.post("/v1/responses").mock(return_value=Response(200, json=make_response()))
        provider = OpenAIResponses(model="gpt-4.1", api_key="test-key", stream=False)
        results = await run_test_cases(mock, provider, TEST_CASES, ("input", "tools"))

        assert results == snapshot(
            {
                "simple_user_message": {
                    "input": [
                        {"role": "developer", "content": "You are helpful."},
                        {
                            "content": [{"type": "input_text", "text": "Hello!"}],
                            "role": "user",
                            "type": "message",
                        },
                    ],
                    "tools": [],
                },
                "multi_turn_conversation": {
                    "input": [
                        {
                            "content": [{"type": "input_text", "text": "What is 2+2?"}],
                            "role": "user",
                            "type": "message",
                        },
                        {
                            "content": [
                                {"type": "output_text", "text": "2+2 equals 4.", "annotations": []}
                            ],
                            "role": "assistant",
                            "type": "message",
                        },
                        {
                            "content": [{"type": "input_text", "text": "And 3+3?"}],
                            "role": "user",
                            "type": "message",
                        },
                    ],
                    "tools": [],
                },
                "multi_turn_with_system": {
                    "input": [
                        {"role": "developer", "content": "You are a math tutor."},
                        {
                            "content": [{"type": "input_text", "text": "What is 2+2?"}],
                            "role": "user",
                            "type": "message",
                        },
                        {
                            "content": [
                                {"type": "output_text", "text": "2+2 equals 4.", "annotations": []}
                            ],
                            "role": "assistant",
                            "type": "message",
                        },
                        {
                            "content": [{"type": "input_text", "text": "And 3+3?"}],
                            "role": "user",
                            "type": "message",
                        },
                    ],
                    "tools": [],
                },
                "image_url": {
                    "input": [
                        {
                            "content": [
                                {"type": "input_text", "text": "What's in this image?"},
                                {
                                    "type": "input_image",
                                    "detail": "auto",
                                    "image_url": "https://example.com/image.png",
                                },
                            ],
                            "role": "user",
                            "type": "message",
                        }
                    ],
                    "tools": [],
                },
                "tool_definition": {
                    "input": [
                        {
                            "content": [{"type": "input_text", "text": "Add 2 and 3"}],
                            "role": "user",
                            "type": "message",
                        }
                    ],
                    "tools": [
                        {
                            "type": "function",
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
                            "strict": False,
                        },
                        {
                            "type": "function",
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
                            "strict": False,
                        },
                    ],
                },
                "tool_call_with_image": {
                    "input": [
                        {
                            "content": [{"type": "input_text", "text": "Add 2 and 3"}],
                            "role": "user",
                            "type": "message",
                        },
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "I'll add those numbers for you.",
                                    "annotations": [],
                                }
                            ],
                            "role": "assistant",
                            "type": "message",
                        },
                        {
                            "arguments": '{"a": 2, "b": 3}',
                            "call_id": "call_abc123",
                            "name": "add",
                            "type": "function_call",
                        },
                        {
                            "call_id": "call_abc123",
                            "output": [
                                {"type": "input_text", "text": "5"},
                                {
                                    "type": "input_image",
                                    "image_url": "https://example.com/image.png",
                                },
                            ],
                            "type": "function_call_output",
                        },
                    ],
                    "tools": [],
                },
                "tool_call": {
                    "input": [
                        {
                            "content": [{"type": "input_text", "text": "Add 2 and 3"}],
                            "role": "user",
                            "type": "message",
                        },
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "I'll add those numbers for you.",
                                    "annotations": [],
                                }
                            ],
                            "role": "assistant",
                            "type": "message",
                        },
                        {
                            "arguments": '{"a": 2, "b": 3}',
                            "call_id": "call_abc123",
                            "name": "add",
                            "type": "function_call",
                        },
                        {
                            "call_id": "call_abc123",
                            "output": [{"type": "input_text", "text": "5"}],
                            "type": "function_call_output",
                        },
                    ],
                    "tools": [],
                },
                "parallel_tool_calls": {
                    "input": [
                        {
                            "content": [{"type": "input_text", "text": "Calculate 2+3 and 4*5"}],
                            "role": "user",
                            "type": "message",
                        },
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "I'll calculate both.",
                                    "annotations": [],
                                }
                            ],
                            "role": "assistant",
                            "type": "message",
                        },
                        {
                            "arguments": '{"a": 2, "b": 3}',
                            "call_id": "call_add",
                            "name": "add",
                            "type": "function_call",
                        },
                        {
                            "arguments": '{"a": 4, "b": 5}',
                            "call_id": "call_mul",
                            "name": "multiply",
                            "type": "function_call",
                        },
                        {
                            "call_id": "call_add",
                            "output": [
                                {
                                    "type": "input_text",
                                    "text": "<system-reminder>This is a system reminder"
                                    "</system-reminder>",
                                },
                                {"type": "input_text", "text": "5"},
                            ],
                            "type": "function_call_output",
                        },
                        {
                            "call_id": "call_mul",
                            "output": [
                                {
                                    "type": "input_text",
                                    "text": "<system-reminder>This is a system reminder"
                                    "</system-reminder>",
                                },
                                {"type": "input_text", "text": "20"},
                            ],
                            "type": "function_call_output",
                        },
                    ],
                    "tools": [
                        {
                            "type": "function",
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
                            "strict": False,
                        },
                        {
                            "type": "function",
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
                            "strict": False,
                        },
                    ],
                },
                "assistant_with_reasoning": {
                    "input": [
                        {
                            "content": [{"type": "input_text", "text": "What is 2+2?"}],
                            "role": "user",
                            "type": "message",
                        },
                        {
                            "summary": [{"type": "summary_text", "text": "Thinking..."}],
                            "type": "reasoning",
                            "encrypted_content": "enc_abc",
                        },
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "4.",
                                    "annotations": [],
                                }
                            ],
                            "role": "assistant",
                            "type": "message",
                        },
                        {
                            "content": [{"type": "input_text", "text": "Thanks!"}],
                            "role": "user",
                            "type": "message",
                        },
                    ],
                    "tools": [],
                },
            }
        )


async def test_openai_responses_generation_kwargs():
    with respx.mock(base_url="https://api.openai.com") as mock:
        mock.post("/v1/responses").mock(return_value=Response(200, json=make_response()))
        provider = OpenAIResponses(
            model="gpt-4.1", api_key="test-key", stream=False
        ).with_generation_kwargs(temperature=0.7, max_output_tokens=2048)
        stream = await provider.generate("", [], [Message(role="user", content="Hi")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert (body["temperature"], body["max_output_tokens"]) == snapshot((0.7, 2048))


async def test_openai_responses_with_thinking():
    with respx.mock(base_url="https://api.openai.com") as mock:
        mock.post("/v1/responses").mock(return_value=Response(200, json=make_response()))
        provider = OpenAIResponses(model="gpt-4.1", api_key="test-key", stream=False).with_thinking(
            "high"
        )
        stream = await provider.generate("", [], [Message(role="user", content="Think")])
        async for _ in stream:
            pass
        body = json.loads(mock.calls.last.request.content.decode())
        assert body["reasoning"] == snapshot({"effort": "high", "summary": "auto"})
