import pytest

from kosong import generate
from kosong.chat_provider import ChatProviderError, StreamedMessagePart, TokenUsage
from kosong.chat_provider.echo import ScriptedEchoChatProvider
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


async def test_scripted_echo_chat_provider_streams_parts():
    dsl = "\n".join(
        [
            "id: scripted-1",
            'usage: {"input_other": 4, "output": 1, "input_cache_read": 2}',
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
    second_dsl = "\n".join(
        [
            "id: scripted-2",
            "text: second turn",
        ]
    )

    provider = ScriptedEchoChatProvider([dsl, second_dsl])
    history = [Message(role="tool", content="tool output")]

    parts: list[StreamedMessagePart] = []
    stream = await provider.generate(system_prompt="", tools=[], history=history)
    async for part in stream:
        parts.append(part)

    assert stream.id == "scripted-1"
    assert stream.usage == TokenUsage(
        input_other=4,
        output=1,
        input_cache_read=2,
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

    second_stream = await provider.generate(system_prompt="", tools=[], history=[])
    second_parts = [part async for part in second_stream]

    assert second_stream.id == "scripted-2"
    assert second_stream.usage is None
    assert second_parts == [TextPart(text="second turn")]


async def test_scripted_echo_chat_provider_exhausted():
    provider = ScriptedEchoChatProvider(["text: only once"])

    await provider.generate(system_prompt="", tools=[], history=[])

    with pytest.raises(ChatProviderError):
        await provider.generate(system_prompt="", tools=[], history=[])


async def test_scripted_echo_chat_provider_with_generate_merge_tool_call():
    dsl = """
    text: Hello
    tool_call: {"id": "tc-1", "name": "get_weather", "arguments": null}
    tool_call_part: {"arguments_part": "{"}
    tool_call_part: {"arguments_part": "\\"city\\":\\"Hangzhou\\""}
    tool_call_part: {"arguments_part": "}"}
    tool_call_part:
    """

    provider = ScriptedEchoChatProvider([dsl])
    history = [Message(role="tool", content="tool output")]

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


async def test_scripted_echo_chat_provider_rejects_non_string_arguments():
    dsl = """
    tool_call: {"id": "call-1", "name": "search", "arguments": {"q": "python"}}
    """
    provider = ScriptedEchoChatProvider([dsl])

    with pytest.raises(ChatProviderError):
        await provider.generate(system_prompt="", tools=[], history=[])


async def test_scripted_echo_chat_provider_requires_dsl_content():
    provider = ScriptedEchoChatProvider(["# comment only\n```"])

    with pytest.raises(ChatProviderError):
        await provider.generate(system_prompt="", tools=[], history=[])
