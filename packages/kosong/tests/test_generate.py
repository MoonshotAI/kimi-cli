import asyncio
from copy import deepcopy

import pytest

from kosong import generate
from kosong.chat_provider import APIEmptyResponseError, StreamedMessagePart
from kosong.chat_provider.mock import MockChatProvider
from kosong.message import ImageURLPart, TextPart, ThinkPart, ToolCall, ToolCallPart


def test_generate():
    chat_provider = MockChatProvider(
        message_parts=[
            TextPart(text="Hello, "),
            TextPart(text="world"),
            TextPart(text="!"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")),
            TextPart(text="Another text."),
            TextPart(text=""),
            ToolCall(
                id="get_weather#123",
                function=ToolCall.FunctionBody(name="get_weather", arguments=None),
            ),
            ToolCallPart(arguments_part="{"),
            ToolCallPart(arguments_part='"city":'),
            ToolCallPart(arguments_part='"Beijing"'),
            ToolCallPart(arguments_part="}"),
            ToolCallPart(arguments_part=None),
        ]
    )
    message = asyncio.run(generate(chat_provider, system_prompt="", tools=[], history=[])).message
    assert message.content == [
        TextPart(text="Hello, world!"),
        ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")),
        TextPart(text="Another text."),
    ]
    assert message.tool_calls == [
        ToolCall(
            id="get_weather#123",
            function=ToolCall.FunctionBody(name="get_weather", arguments='{"city":"Beijing"}'),
        ),
    ]


def test_generate_with_callbacks():
    input_parts: list[StreamedMessagePart] = [
        TextPart(text="Hello, "),
        TextPart(text="world"),
        TextPart(text="!"),
        ToolCall(
            id="get_weather#123",
            function=ToolCall.FunctionBody(name="get_weather", arguments=None),
        ),
        ToolCallPart(arguments_part="{"),
        ToolCallPart(arguments_part='"city":'),
        ToolCallPart(arguments_part='"Beijing"'),
        ToolCallPart(arguments_part="}"),
        ToolCall(
            id="get_time#123",
            function=ToolCall.FunctionBody(name="get_time", arguments=""),
        ),
    ]
    chat_provider = MockChatProvider(message_parts=deepcopy(input_parts))

    output_parts: list[StreamedMessagePart] = []
    output_tool_calls: list[ToolCall] = []

    async def on_message_part(part: StreamedMessagePart):
        output_parts.append(part)

    async def on_tool_call(tool_call: ToolCall):
        output_tool_calls.append(tool_call)

    message = asyncio.run(
        generate(
            chat_provider,
            system_prompt="",
            tools=[],
            history=[],
            on_message_part=on_message_part,
            on_tool_call=on_tool_call,
        )
    ).message
    assert output_parts == input_parts
    assert output_tool_calls == message.tool_calls


def test_generate_think_only_raises_error():
    """Think-only response (no text, no tool calls) should raise APIEmptyResponseError."""
    chat_provider = MockChatProvider(
        message_parts=[
            ThinkPart(think="Deep thinking about the problem..."),
        ]
    )
    with pytest.raises(APIEmptyResponseError, match="only thinking content"):
        asyncio.run(generate(chat_provider, system_prompt="", tools=[], history=[]))


def test_generate_think_with_empty_text_raises_error():
    """ThinkPart + empty/whitespace TextPart should also raise APIEmptyResponseError."""
    chat_provider = MockChatProvider(
        message_parts=[
            ThinkPart(think="Thinking..."),
            TextPart(text="  \n  "),
        ]
    )
    with pytest.raises(APIEmptyResponseError, match="only thinking content"):
        asyncio.run(generate(chat_provider, system_prompt="", tools=[], history=[]))


def test_generate_think_with_text_succeeds():
    """ThinkPart + real TextPart should succeed normally."""
    chat_provider = MockChatProvider(
        message_parts=[
            ThinkPart(think="Let me think..."),
            TextPart(text="Here is the answer."),
        ]
    )
    result = asyncio.run(generate(chat_provider, system_prompt="", tools=[], history=[]))
    assert any(isinstance(p, ThinkPart) for p in result.message.content)
    assert any(isinstance(p, TextPart) for p in result.message.content)


def test_generate_think_with_tool_calls_succeeds():
    """ThinkPart + tool calls (no text) should succeed — tools are valid output."""
    chat_provider = MockChatProvider(
        message_parts=[
            ThinkPart(think="I should call a tool..."),
            ToolCall(
                id="tool#1",
                function=ToolCall.FunctionBody(name="read_file", arguments='{"path": "/tmp"}'),
            ),
        ]
    )
    result = asyncio.run(generate(chat_provider, system_prompt="", tools=[], history=[]))
    assert any(isinstance(p, ThinkPart) for p in result.message.content)
    assert result.message.tool_calls
