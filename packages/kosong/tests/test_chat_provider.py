import asyncio
import json
from types import SimpleNamespace
from typing import Any, cast

from kosong.chat_provider import APIStatusError, StreamedMessagePart
from kosong.chat_provider.chaos import ChaosChatProvider, ChaosConfig
from kosong.chat_provider.kimi import Kimi
from kosong.chat_provider.mock import MockChatProvider
from kosong.message import Message, TextPart


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


async def test_kimi_sanitizes_surrogates_before_request():
    class FakeCompletions:
        def __init__(self) -> None:
            self.kwargs: dict[str, Any] = {}

        async def create(self, **kwargs: Any) -> Any:
            request = dict(kwargs)
            request["tools"] = list(request["tools"])
            json.dumps(request, ensure_ascii=False).encode("utf-8")
            self.kwargs = request
            return SimpleNamespace()

    completions = FakeCompletions()
    chat_provider = Kimi(model="dummy", api_key="sk-1234567890")
    chat_provider.client = cast(
        Any, SimpleNamespace(chat=SimpleNamespace(completions=completions))
    )

    await chat_provider.generate(
        system_prompt="system\udca9",
        tools=[],
        history=[Message(role="user", content=[TextPart(text="hello\udca9")])],
    )

    messages = completions.kwargs["messages"]
    assert "\ufffd" in messages[0]["content"]
    assert "\ufffd" in messages[1]["content"]
