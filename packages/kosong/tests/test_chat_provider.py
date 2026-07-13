import asyncio
from collections.abc import Sequence
from typing import Any, cast

from kosong.chat_provider import APIStatusError, StreamedMessagePart
from kosong.chat_provider.chaos import ChaosChatProvider, ChaosConfig
from kosong.chat_provider.kimi import Kimi
from kosong.chat_provider.mock import MockChatProvider
from kosong.message import Message, TextPart
from kosong.tooling import Tool


class _LegacyStream:
    id = "legacy-response"
    usage = None

    async def __aiter__(self):
        yield TextPart(text="legacy ok")


class _LegacyProvider:
    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> _LegacyStream:
        del system_prompt, tools, history
        return _LegacyStream()


class _LegacyChaosProvider(ChaosChatProvider):
    def __init__(self) -> None:
        self._provider = cast(Any, _LegacyProvider())
        self._chaos_config = ChaosConfig()


def test_mock_chat_provider():
    input_parts: list[StreamedMessagePart] = [
        TextPart(text="Hello, world!"),
    ]

    async def generate() -> list[StreamedMessagePart]:
        chat_provider = MockChatProvider(message_parts=input_parts)
        parts: list[StreamedMessagePart] = []
        async for part in await chat_provider.generate(system_prompt="", tools=[], history=[]):
            parts.append(part)
        return parts

    output_parts = asyncio.run(generate())
    assert output_parts == input_parts


async def test_chaos_chat_provider():
    base = Kimi(model="dummy", api_key="sk-1234567890")
    chat_provider = ChaosChatProvider(
        base,
        chaos_config=ChaosConfig(error_probability=1.0),
    )
    for _ in range(3):
        try:
            parts: list[StreamedMessagePart] = []
            async for part in await chat_provider.generate(
                system_prompt="",
                tools=[],
                history=[Message(role="user", content=[TextPart(text="Hello, world!")])],
            ):
                parts.append(part)
            raise AssertionError("Expected APIStatusError")
        except APIStatusError:
            pass


async def test_chaos_without_overrides_preserves_legacy_provider_signature():
    chat_provider = _LegacyChaosProvider()

    stream = await chat_provider.generate(system_prompt="", tools=[], history=[])
    parts = [part async for part in stream]

    assert parts == [TextPart(text="legacy ok")]
