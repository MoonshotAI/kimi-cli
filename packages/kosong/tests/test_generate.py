import asyncio
from copy import deepcopy

from kosong import generate
from kosong.chat_provider import StreamedMessagePart
from kosong.chat_provider.mock import MockChatProvider
from kosong.message import ImageURLPart, TextPart, ToolCall, ToolCallPart


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
