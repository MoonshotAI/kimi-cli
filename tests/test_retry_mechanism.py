"""Test retry mechanism for network errors."""
import httpx
from kosong.chat_provider import APIConnectionError, APIStatusError, APITimeoutError

from kimi_cli.soul.kimisoul import KimiSoul


def test_is_retryable_error_httpx_remote_protocol_error():
    """Test that httpx.RemoteProtocolError is retryable (for truncated responses)."""
    error = httpx.RemoteProtocolError(
        "peer closed connection without sending complete message body (incomplete chunked read)"
    )
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_connection_error():
    """Test that APIConnectionError is retryable."""
    error = APIConnectionError("Connection failed")
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_timeout_error():
    """Test that APITimeoutError is retryable."""
    error = APITimeoutError("Request timed out")
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_status_error_429():
    """Test that 429 Too Many Requests is retryable."""
    error = APIStatusError(status_code=429, message="Too many requests")
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_status_error_500():
    """Test that 500 Internal Server Error is retryable."""
    error = APIStatusError(status_code=500, message="Internal server error")
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_status_error_502():
    """Test that 502 Bad Gateway is retryable."""
    error = APIStatusError(status_code=502, message="Bad gateway")
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_status_error_503():
    """Test that 503 Service Unavailable is retryable."""
    error = APIStatusError(status_code=503, message="Service unavailable")
    assert KimiSoul._is_retryable_error(error) is True


def test_is_retryable_error_api_status_error_404():
    """Test that 404 Not Found is NOT retryable."""
    error = APIStatusError(status_code=404, message="Not found")
    assert KimiSoul._is_retryable_error(error) is False


def test_is_retryable_error_api_status_error_401():
    """Test that 401 Unauthorized is NOT retryable."""
    error = APIStatusError(status_code=401, message="Unauthorized")
    assert KimiSoul._is_retryable_error(error) is False


def test_is_retryable_error_generic_exception():
    """Test that generic exceptions are NOT retryable."""
    error = ValueError("Some error")
    assert KimiSoul._is_retryable_error(error) is False


def test_is_retryable_error_runtime_error():
    """Test that RuntimeError is NOT retryable."""
    error = RuntimeError("Runtime error")
    assert KimiSoul._is_retryable_error(error) is False
