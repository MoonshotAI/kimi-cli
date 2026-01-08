from __future__ import annotations

import httpx
import pytest

from kimi_sdk import Kimi, Message, generate


def _chat_completion_response() -> dict[str, object]:
    return {
        "id": "chatcmpl-test123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "kimi-k2-turbo-preview",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


@pytest.mark.asyncio
async def test_generate_smoke() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, json=_chat_completion_response())

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        kimi = Kimi(
            model="kimi-k2-turbo-preview",
            api_key="test-key",
            stream=False,
            http_client=http_client,
        )
        result = await generate(
            chat_provider=kimi,
            system_prompt="You are helpful.",
            tools=[],
            history=[Message(role="user", content="Hi")],
        )

    assert result.message.role == "assistant"
    assert result.message.extract_text() == "Hello"
    assert result.usage is not None
    assert result.usage.input_other == 10
    assert result.usage.output == 5
