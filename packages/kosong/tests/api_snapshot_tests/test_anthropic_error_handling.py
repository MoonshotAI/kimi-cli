"""Tests for Anthropic provider error handling, especially httpx exception conversion.

These tests guard against httpx exceptions leaking through the Anthropic SDK
during streaming — the root cause of the evaluation zero-score bug where
httpx.ReadTimeout bypassed retry logic and crashed the process.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

pytest.importorskip("anthropic", reason="Optional contrib dependency not installed")

from anthropic import (
    APIConnectionError as AnthropicAPIConnectionError,
)
from anthropic import (
    APITimeoutError as AnthropicAPITimeoutError,
)

from kosong.chat_provider import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
    convert_httpx_error,
)
from kosong.contrib.chat_provider.anthropic import (
    AnthropicStreamedMessage,
    _convert_error,  # pyright: ignore[reportPrivateUsage]
)

# ---------------------------------------------------------------------------
# Shared convert_httpx_error (kosong.chat_provider)
# ---------------------------------------------------------------------------


class TestConvertHttpxError:
    """The shared convert_httpx_error utility must correctly map every httpx
    exception subclass to the corresponding kosong ChatProviderError."""

    @pytest.mark.parametrize(
        ("exc", "expected_type"),
        [
            (httpx.ReadTimeout("read timed out"), APITimeoutError),
            (httpx.ConnectTimeout("connect timed out"), APITimeoutError),
            (httpx.WriteTimeout("write timed out"), APITimeoutError),
            (httpx.PoolTimeout("pool timed out"), APITimeoutError),
            (httpx.NetworkError("connection reset"), APIConnectionError),
            (httpx.RemoteProtocolError("remote protocol error"), APIConnectionError),
            (httpx.LocalProtocolError("local protocol error"), ChatProviderError),
            (httpx.DecodingError("decode failed"), ChatProviderError),
        ],
        ids=[
            "ReadTimeout",
            "ConnectTimeout",
            "WriteTimeout",
            "PoolTimeout",
            "NetworkError",
            "RemoteProtocolError",
            "LocalProtocolError",
            "DecodingError",
        ],
    )
    def test_httpx_error_mapping(
        self, exc: httpx.HTTPError, expected_type: type[ChatProviderError]
    ) -> None:
        assert isinstance(convert_httpx_error(exc), expected_type)

    def test_http_status_error(self) -> None:
        response = httpx.Response(502, request=httpx.Request("POST", "https://api.test"))
        exc = httpx.HTTPStatusError("bad gateway", request=response.request, response=response)
        err = convert_httpx_error(exc)
        assert isinstance(err, APIStatusError)
        assert err.status_code == 502


# ---------------------------------------------------------------------------
# Anthropic-specific _convert_error
# ---------------------------------------------------------------------------


class TestAnthropicConvertError:
    """Anthropic's _convert_error must handle both AnthropicError and httpx.HTTPError,
    and must check APITimeoutError before APIConnectionError (inheritance order)."""

    def test_timeout_not_misclassified_as_connection(self) -> None:
        """AnthropicAPITimeoutError inherits from AnthropicAPIConnectionError.
        The conversion must check timeout FIRST to avoid misclassifying it."""
        err = _convert_error(AnthropicAPITimeoutError(request=None))  # pyright: ignore[reportArgumentType]
        assert type(err) is APITimeoutError

    def test_connection_error(self) -> None:
        err = _convert_error(AnthropicAPIConnectionError(request=None))  # pyright: ignore[reportArgumentType]
        assert isinstance(err, APIConnectionError)

    def test_delegates_httpx_to_shared_converter(self) -> None:
        """httpx errors should be delegated to convert_httpx_error."""
        err = _convert_error(httpx.ReadTimeout("stream timed out"))
        assert isinstance(err, APITimeoutError)

        err = _convert_error(httpx.NetworkError("connection reset"))
        assert isinstance(err, APIConnectionError)


# ---------------------------------------------------------------------------
# Streaming error propagation (integration)
# ---------------------------------------------------------------------------


def _make_failing_stream(exc: Exception) -> AnthropicStreamedMessage:
    """Create an AnthropicStreamedMessage whose underlying async stream
    raises the given exception during iteration."""
    mock_stream = AsyncMock()

    async def _raise(*_args: Any, **_kwargs: Any) -> None:
        raise exc

    mock_manager = AsyncMock()
    mock_manager.__aenter__ = AsyncMock(return_value=mock_stream)
    mock_manager.__aexit__ = AsyncMock(return_value=False)
    mock_stream.__aiter__ = MagicMock(return_value=mock_stream)
    mock_stream.__anext__ = _raise
    return AnthropicStreamedMessage(mock_manager)


class TestStreamingErrorPropagation:
    """When httpx exceptions occur during stream consumption,
    AnthropicStreamedMessage._convert_stream_response must catch them
    and convert to kosong error types — not let them leak to the caller."""

    async def test_read_timeout(self) -> None:
        msg = _make_failing_stream(httpx.ReadTimeout("stream timed out after 600s"))
        with pytest.raises(APITimeoutError, match="stream timed out"):
            async for _ in msg:
                pass

    async def test_network_error(self) -> None:
        msg = _make_failing_stream(httpx.NetworkError("connection reset by peer"))
        with pytest.raises(APIConnectionError, match="connection reset"):
            async for _ in msg:
                pass

    async def test_connect_timeout(self) -> None:
        msg = _make_failing_stream(httpx.ConnectTimeout("connect timed out"))
        with pytest.raises(APITimeoutError, match="connect timed out"):
            async for _ in msg:
                pass
