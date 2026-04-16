import asyncio
from typing import Any

import httpx
import openai
import pytest

from kosong.chat_provider import (
    APIConnectionError,
    APITimeoutError,
    ChatProviderError,
    openai_common,
)
from kosong.chat_provider.openai_common import convert_error
from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy


def test_create_openai_client_does_not_inject_max_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    class FakeAsyncOpenAI:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(openai_common, "AsyncOpenAI", FakeAsyncOpenAI)

    openai_common.create_openai_client(
        api_key="test-key",
        base_url="https://example.com/v1",
        client_kwargs={"timeout": 3},
    )

    assert captured["api_key"] == "test-key"
    assert captured["base_url"] == "https://example.com/v1"
    assert captured["timeout"] == 3
    assert "max_retries" not in captured


@pytest.mark.asyncio
async def test_retry_recovery_does_not_close_shared_http_client() -> None:
    http_client = httpx.AsyncClient()
    provider = OpenAILegacy(
        model="gpt-4.1",
        api_key="test-key",
        http_client=http_client,
    )

    provider.on_retryable_error(APIConnectionError("Connection error."))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert provider.client._client is http_client  # type: ignore[reportPrivateUsage]
    assert http_client.is_closed is False
    await http_client.aclose()


# ---------------------------------------------------------------------------
# convert_error: openai.APIError (base class) handling
# ---------------------------------------------------------------------------

_DUMMY_REQUEST = httpx.Request("POST", "https://api.test")


class TestConvertErrorBaseAPIError:
    """openai.APIError (the base class, NOT APIConnectionError) must be
    correctly mapped when the error message indicates a network issue.

    This guards against the bug where streaming mid-flight disconnections
    raise ``openai.APIError("Network connection lost.")`` instead of
    ``openai.APIConnectionError``, and the converter falls through to
    the generic ``ChatProviderError`` — bypassing all retry/recovery logic.
    """

    @pytest.mark.parametrize(
        ("message", "expected_type"),
        [
            ("Network connection lost.", APIConnectionError),
            ("Connection error.", APIConnectionError),
            ("network error", APIConnectionError),
            ("disconnected from server", APIConnectionError),
            ("connection reset by peer", APIConnectionError),
            ("connection closed unexpectedly", APIConnectionError),
            ("Request timed out.", APITimeoutError),
            ("timed out", APITimeoutError),
            # Timeout must take priority over network when both patterns match.
            ("connection timed out", APITimeoutError),
            ("Something completely unrelated", ChatProviderError),
            ("Internal server error", ChatProviderError),
            # Bare "reset"/"closed" must NOT match — they are too broad
            # and could appear in non-network server messages.
            ("Your session has been reset", ChatProviderError),
            ("Stream closed by server due to policy violation", ChatProviderError),
        ],
        ids=[
            "network_connection_lost",
            "connection_error",
            "network_error",
            "disconnected",
            "connection_reset_by_peer",
            "connection_closed_unexpectedly",
            "request_timed_out",
            "timed_out",
            "connection_timed_out_timeout_priority",
            "unrelated_error",
            "internal_server_error",
            "bare_reset_no_match",
            "bare_closed_no_match",
        ],
    )
    def test_base_api_error_mapping(
        self, message: str, expected_type: type[ChatProviderError]
    ) -> None:
        err = openai.APIError(message=message, request=_DUMMY_REQUEST, body=None)
        result = convert_error(err)
        assert type(result) is expected_type, (
            f"Expected {expected_type.__name__} for message={message!r}, "
            f"got {type(result).__name__}"
        )

    def test_subclass_errors_still_match_first(self) -> None:
        """Existing specific error types must still be matched before
        the new base APIError branch."""
        # APIConnectionError should still match its own case
        conn_err = openai.APIConnectionError(request=_DUMMY_REQUEST)
        result = convert_error(conn_err)
        assert type(result) is APIConnectionError

        # APITimeoutError should still match its own case
        timeout_err = openai.APITimeoutError(request=_DUMMY_REQUEST)
        result = convert_error(timeout_err)
        assert type(result) is APITimeoutError

    def test_api_error_with_body_skips_heuristic(self) -> None:
        """SSE error events carry a body dict — they must NOT be
        heuristically reclassified, even if the message contains
        network keywords."""
        err = openai.APIError(
            message="Connection limit exceeded",
            request=_DUMMY_REQUEST,
            body={"error": {"message": "Connection limit exceeded", "type": "server_error"}},
        )
        result = convert_error(err)
        assert type(result) is ChatProviderError

    def test_api_response_validation_error_falls_through(self) -> None:
        """APIResponseValidationError has a body and must not be
        heuristically reclassified even if message contains keywords."""
        resp = httpx.Response(200, request=_DUMMY_REQUEST)
        err = openai.APIResponseValidationError(
            response=resp,
            body=None,
            message="connection field missing in response",
        )
        # APIResponseValidationError sets body from the response parsing,
        # but even with body=None the guard only applies to exact APIError;
        # however APIResponseValidationError IS an APIError subclass.
        # The key point: it should become ChatProviderError, not APIConnectionError.
        result = convert_error(err)
        assert type(result) is ChatProviderError


# ---------------------------------------------------------------------------
# Streaming error propagation (integration)
# ---------------------------------------------------------------------------


class TestOpenAIStreamingErrorPropagation:
    """When openai.APIError is raised during OpenAI stream consumption,
    _convert_stream_response must convert it to the correct kosong error type.

    This is the exact scenario from the bug: streaming for ~33 minutes,
    then the SSE connection drops and the SDK raises
    openai.APIError("Network connection lost.") — which must become
    APIConnectionError so that retry/recovery logic triggers.
    """

    async def test_base_api_error_becomes_connection_error(self) -> None:
        """openai.APIError("Network connection lost.") during streaming
        must surface as kosong APIConnectionError."""
        from kosong.contrib.chat_provider.openai_legacy import OpenAILegacyStreamedMessage

        async def _failing_stream() -> Any:
            raise openai.APIError(
                message="Network connection lost.",
                request=_DUMMY_REQUEST,
                body=None,
            )
            yield  # make this an async generator  # noqa: RUF027

        msg = OpenAILegacyStreamedMessage(_failing_stream(), reasoning_key=None)  # type: ignore[arg-type]
        with pytest.raises(APIConnectionError, match="Network connection lost"):
            async for _ in msg:
                pass
