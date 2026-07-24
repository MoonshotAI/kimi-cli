"""Verify ``x-trace-id`` response header capture and propagation.

The KFC inference service returns a trace id in the ``x-trace-id`` response
header. It must be captured by the Kimi provider (both success and error
paths) and propagated through ``generate``/``step`` results and the
``on_trace_id`` early callback.
"""

from typing import Any, cast

import httpx
import pytest
import respx
from openai.types.chat import ChatCompletion

import kosong
from kosong.chat_provider import APIStatusError, StreamedMessage
from kosong.chat_provider.kimi import Kimi
from kosong.tooling.empty import EmptyToolset

TRACE_ID = "trace-abc-123"
URL = "https://api.moonshot.ai/v1/chat/completions"


class _LegacyStreamedMessage:
    """Third-party stream shape from before trace metadata was introduced."""

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    @property
    def id(self) -> str | None:
        return None

    @property
    def usage(self):
        return None


def test_trace_id_does_not_break_legacy_stream_protocol_compatibility():
    assert isinstance(_LegacyStreamedMessage(), StreamedMessage)


def _completion_payload() -> dict[str, object]:
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1,
        "model": "test-model",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


@pytest.mark.asyncio
async def test_kimi_captures_trace_id_header():
    with respx.mock:
        respx.post(URL).mock(
            return_value=httpx.Response(
                200, json=_completion_payload(), headers={"x-trace-id": TRACE_ID}
            )
        )
        provider = Kimi(model="test-model", api_key="token", stream=False)
        stream = await provider.generate("", [], [])
        assert stream.trace_id == TRACE_ID
        async for _ in stream:
            pass


@pytest.mark.asyncio
async def test_kimi_trace_id_none_without_header():
    with respx.mock:
        respx.post(URL).mock(return_value=httpx.Response(200, json=_completion_payload()))
        provider = Kimi(model="test-model", api_key="token", stream=False)
        stream = await provider.generate("", [], [])
        assert stream.trace_id is None


@pytest.mark.asyncio
async def test_kimi_streaming_captures_trace_id():
    """Streaming path returns before the response body is consumed."""
    sse = (
        'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,'
        '"model":"test-model","choices":[{"index":0,'
        '"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n'
        'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,'
        '"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )
    with respx.mock:
        respx.post(URL).mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/event-stream", "x-trace-id": TRACE_ID},
                content=sse,
            )
        )
        provider = Kimi(model="test-model", api_key="token", stream=True)
        stream = await provider.generate("", [], [])
        assert stream.trace_id == TRACE_ID
        parts = [part async for part in stream]
        assert parts


@pytest.mark.asyncio
async def test_kimi_streaming_uses_stream_response_headers():
    class DelayedStream:
        response = httpx.Response(200, headers={"x-trace-id": TRACE_ID})

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise AssertionError("the response body must not be consumed in generate")

    class Completions:
        async def create(self, **kwargs: Any):
            assert kwargs["stream"] is True
            return DelayedStream()

    provider = Kimi(model="test-model", api_key="token", stream=True)
    cast(Any, provider).client = type(
        "FakeClient",
        (),
        {"chat": type("FakeChat", (), {"completions": Completions()})()},
    )()

    stream = await provider.generate("", [], [])
    assert stream.trace_id == TRACE_ID


@pytest.mark.asyncio
async def test_kimi_accepts_async_raw_response_parse():
    class AsyncRawResponse:
        headers = {"x-trace-id": TRACE_ID}

        async def parse(self):
            return ChatCompletion.model_validate(_completion_payload())

    class Completions:
        class WithRawResponse:
            async def create(self, **kwargs: Any):
                return AsyncRawResponse()

        with_raw_response = WithRawResponse()

    provider = Kimi(model="test-model", api_key="token", stream=False)
    cast(Any, provider).client = type(
        "FakeClient",
        (),
        {"chat": type("FakeChat", (), {"completions": Completions()})()},
    )()

    stream = await provider.generate("", [], [])
    assert stream.trace_id == TRACE_ID
    parts = [part async for part in stream]
    assert parts


@pytest.mark.asyncio
async def test_api_status_error_carries_trace_id():
    with respx.mock:
        respx.post(URL).mock(
            return_value=httpx.Response(
                500,
                json={"error": {"message": "boom", "type": "server_error"}},
                headers={"x-trace-id": TRACE_ID},
            )
        )
        provider = Kimi(model="test-model", api_key="token", stream=False)
        with pytest.raises(APIStatusError) as exc_info:
            await provider.generate("", [], [])
        assert exc_info.value.trace_id == TRACE_ID


@pytest.mark.asyncio
async def test_step_result_and_on_trace_id_callback():
    seen: list[str | None] = []
    with respx.mock:
        respx.post(URL).mock(
            return_value=httpx.Response(
                200, json=_completion_payload(), headers={"x-trace-id": TRACE_ID}
            )
        )
        provider = Kimi(model="test-model", api_key="token", stream=False)
        result = await kosong.step(
            chat_provider=provider,
            system_prompt="",
            toolset=EmptyToolset(),
            history=[],
            on_trace_id=seen.append,
        )
        assert result.trace_id == TRACE_ID
        assert seen == [TRACE_ID]
