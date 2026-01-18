import pytest

from kosong import generate
from kosong.chat_provider import ChatProviderError, StreamedMessagePart, TokenUsage
from kosong.chat_provider.echo import EchoChatProvider
from kosong.message import (
    AudioURLPart,
    ImageURLPart,
    Message,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
    VideoURLPart,
)


async def test_echo_chat_provider_streams_parts():
    dsl = "\n".join(
        [
            "id: echo-42",
            'usage: {"input_other": 10, "output": 2, "input_cache_read": 3}',
            "text: Hello,",
            "text:  world!",
            "think: thinking...",
            'image_url: {"url": "https://example.com/image.png", "id": "img-1"}',
            "audio_url: https://example.com/audio.mp3",
            "video_url: https://example.com/video.mp4",
            (
                'tool_call: {"id": "call-1", "name": "search", '
                '"arguments": "{\\"q\\":\\"python\\"", "extras": {"source": "test"}}'
            ),
            'tool_call_part: {"arguments_part": "}"}',
        ]
    )

    provider = EchoChatProvider()
    history = [Message(role="user", content=dsl)]

    parts: list[StreamedMessagePart] = []
    stream = await provider.generate(system_prompt="", tools=[], history=history)
    async for part in stream:
        parts.append(part)

    assert stream.id == "echo-42"
    assert stream.usage == TokenUsage(
        input_other=10,
        output=2,
        input_cache_read=3,
        input_cache_creation=0,
    )
    assert parts == [
        TextPart(text="Hello,"),
        TextPart(text=" world!"),
        ThinkPart(think="thinking...", encrypted=None),
        ImageURLPart(
            image_url=ImageURLPart.ImageURL(url="https://example.com/image.png", id="img-1")
        ),
        AudioURLPart(audio_url=AudioURLPart.AudioURL(url="https://example.com/audio.mp3", id=None)),
        VideoURLPart(video_url=VideoURLPart.VideoURL(url="https://example.com/video.mp4", id=None)),
        ToolCall(
            id="call-1",
            function=ToolCall.FunctionBody(name="search", arguments='{"q":"python"'),
            extras={"source": "test"},
        ),
        ToolCallPart(arguments_part="}"),
    ]


async def test_echo_chat_provider_with_generate_merge_tool_call():
    dsl = """
    text: Hello
    tool_call: {"id": "tc-1", "name": "get_weather", "arguments": null}
    tool_call_part: {"arguments_part": "{"}
    tool_call_part: {"arguments_part": "\\"city\\":\\"Hangzhou\\""}
    tool_call_part: {"arguments_part": "}"}
    tool_call_part:
    """

    provider = EchoChatProvider()
    history = [Message(role="user", content=dsl)]

    result = await generate(
        chat_provider=provider,
        system_prompt="",
        tools=[],
        history=history,
    )
    message = result.message

    assert message.content == [TextPart(text="Hello")]
    assert message.tool_calls == [
        ToolCall(
            id="tc-1",
            function=ToolCall.FunctionBody(name="get_weather", arguments='{"city":"Hangzhou"}'),
        )
    ]
    assert result.usage is None


async def test_echo_chat_provider_rejects_non_string_arguments():
    dsl = """
    tool_call: {"id": "call-1", "name": "search", "arguments": {"q": "python"}}
    """
    provider = EchoChatProvider()
    history = [Message(role="user", content=dsl)]

    with pytest.raises(ChatProviderError):
        await provider.generate(system_prompt="", tools=[], history=history)


async def test_echo_chat_provider_requires_user_message():
    provider = EchoChatProvider()
    history = [Message(role="tool", content="tool output")]

    with pytest.raises(ChatProviderError):
        await provider.generate(system_prompt="", tools=[], history=history)


async def test_echo_chat_provider_requires_dsl_content():
    provider = EchoChatProvider()
    history = [Message(role="user", content="")]

    with pytest.raises(ChatProviderError):
        await provider.generate(system_prompt="", tools=[], history=history)
