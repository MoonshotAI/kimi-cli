"""Tests for Print mode exit code handling."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from kosong.chat_provider import (
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
)

from kimi_cli.cli import ExitCode
from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled
from kimi_cli.ui.print import Print

# ---------------------------------------------------------------------------
# _classify_provider_error unit tests
# ---------------------------------------------------------------------------


class TestClassifyProviderError:
    def test_connection_error_is_retryable(self):
        e = APIConnectionError("connection refused")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_timeout_error_is_retryable(self):
        e = APITimeoutError("request timed out")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_empty_response_error_is_retryable(self):
        e = APIEmptyResponseError("empty response")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_429_rate_limit_is_retryable(self):
        e = APIStatusError(429, "rate limit exceeded")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_500_server_error_is_retryable(self):
        e = APIStatusError(500, "internal server error")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_502_bad_gateway_is_retryable(self):
        e = APIStatusError(502, "bad gateway")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_503_service_unavailable_is_retryable(self):
        e = APIStatusError(503, "service unavailable")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_401_unauthorized_is_failure(self):
        e = APIStatusError(401, "unauthorized")
        assert Print._classify_provider_error(e) == ExitCode.FAILURE

    def test_403_forbidden_is_failure(self):
        e = APIStatusError(403, "forbidden")
        assert Print._classify_provider_error(e) == ExitCode.FAILURE

    def test_400_bad_request_is_failure(self):
        e = APIStatusError(400, "bad request")
        assert Print._classify_provider_error(e) == ExitCode.FAILURE

    def test_501_not_implemented_is_failure(self):
        e = APIStatusError(501, "not implemented")
        assert Print._classify_provider_error(e) == ExitCode.FAILURE

    def test_504_gateway_timeout_is_retryable(self):
        e = APIStatusError(504, "gateway timeout")
        assert Print._classify_provider_error(e) == ExitCode.RETRYABLE

    def test_generic_chat_provider_error_is_failure(self):
        e = ChatProviderError("unknown provider error")
        assert Print._classify_provider_error(e) == ExitCode.FAILURE


# ---------------------------------------------------------------------------
# Print.run() exit code integration tests
# ---------------------------------------------------------------------------


def _make_print(soul: AsyncMock, tmp_path: Path) -> Print:
    return Print(
        soul=soul,
        input_format="text",
        output_format="text",
        context_file=tmp_path / "context.json",
    )


def _make_soul() -> AsyncMock:
    soul = AsyncMock()
    soul.runtime = None
    return soul


def _make_llm_not_supported() -> LLMNotSupported:
    mock_llm = MagicMock()
    mock_llm.model_name = "test-model"
    return LLMNotSupported(mock_llm, ["image_in"])


class TestPrintRunExitCode:
    def test_success_on_normal_run(self, tmp_path: Path):
        """Normal command execution → success."""
        soul = _make_soul()
        p = _make_print(soul, tmp_path)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.SUCCESS

    def test_llm_not_set_returns_failure(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise LLMNotSet()

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.FAILURE

    def test_llm_not_supported_returns_failure(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise _make_llm_not_supported()

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.FAILURE

    def test_max_steps_returns_failure(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise MaxStepsReached(10)

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.FAILURE

    def test_run_cancelled_returns_failure(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise RunCancelled()

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.FAILURE

    def test_rate_limit_429_returns_retryable(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise APIStatusError(429, "rate limit exceeded")

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.RETRYABLE

    def test_server_error_500_returns_retryable(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise APIStatusError(500, "internal server error")

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.RETRYABLE

    def test_connection_error_returns_retryable(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise APIConnectionError("connection refused")

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.RETRYABLE

    def test_auth_error_401_returns_failure(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise APIStatusError(401, "unauthorized")

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        code = asyncio.run(p.run(command="hello"))
        assert code == ExitCode.FAILURE

    def test_unknown_exception_propagates(self, tmp_path: Path, monkeypatch):
        soul = _make_soul()
        p = _make_print(soul, tmp_path)

        async def _raise(*args, **kwargs):
            raise RuntimeError("unexpected")

        monkeypatch.setattr("kimi_cli.ui.print.run_soul", _raise)
        with pytest.raises(RuntimeError, match="unexpected"):
            asyncio.run(p.run(command="hello"))
