"""Tests for the /feedback shell slash command."""

from __future__ import annotations

from collections.abc import Awaitable
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import aiohttp
import pytest
from kosong.tooling.empty import EmptyToolset
from pydantic import SecretStr

from kimi_cli.config import LLMProvider, OAuthRef
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.ui.shell.slash import shell_mode_registry


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return SimpleNamespace(soul=soul)


def _setup_feedback_provider(runtime: Runtime) -> None:
    """Add a managed:kimi-code provider with OAuth to the runtime config."""
    runtime.config.providers["managed:kimi-code"] = LLMProvider(
        type="kimi",
        base_url="https://api.kimi.com/coding/v1",
        api_key=SecretStr("test-api-key"),
        oauth=OAuthRef(storage="file", key="oauth/kimi-code"),
        custom_headers={"x-canary-kfc": "always"},
    )


def _mock_client_session(*, response_status=204, side_effect=None):
    """Create a mock for new_client_session that simulates aiohttp behavior."""
    mock_response = AsyncMock()
    mock_response.status = response_status
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=False)

    mock_session = AsyncMock()
    if side_effect:
        mock_session.post = Mock(side_effect=side_effect)
    else:
        mock_session.post = Mock(return_value=mock_response)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    return Mock(return_value=mock_session)


def _setup_submission_mocks(monkeypatch, *, feedback_text="Great tool!", session_factory=None):
    """Common mock setup for tests that reach the HTTP submission phase."""
    print_mock = Mock()
    open_mock = Mock(return_value=True)
    monkeypatch.setattr(shell_slash.console, "print", print_mock)
    monkeypatch.setattr(shell_slash.console, "status", lambda *_a, **_kw: nullcontext())
    monkeypatch.setattr("webbrowser.open", open_mock)
    monkeypatch.setattr(
        "prompt_toolkit.PromptSession.prompt_async",
        AsyncMock(return_value=feedback_text),
    )
    if session_factory is not None:
        monkeypatch.setattr("kimi_cli.utils.aiohttp.new_client_session", session_factory)
    return print_mock, open_mock


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


class TestFeedbackRegistration:
    def test_registered_in_shell_registry(self) -> None:
        cmd = shell_slash_registry.find_command("feedback")
        assert cmd is not None
        assert cmd.name == "feedback"

    def test_registered_in_shell_mode_registry(self) -> None:
        cmd = shell_mode_registry.find_command("feedback")
        assert cmd is not None


# ---------------------------------------------------------------------------
# Guards → fallback to GitHub issues
# ---------------------------------------------------------------------------


class TestFeedbackGuards:
    async def test_fallback_when_no_kimi_soul(self, monkeypatch) -> None:
        """When soul is not KimiSoul, should fallback to GitHub issues."""
        shell = Mock()
        shell.soul = Mock()  # not spec=KimiSoul

        open_mock = Mock(return_value=True)
        monkeypatch.setattr("webbrowser.open", open_mock)

        ret = shell_slash.feedback(cast(Shell, shell), "")
        if isinstance(ret, Awaitable):
            await ret

        open_mock.assert_called_once()
        assert "issues" in open_mock.call_args.args[0]

    async def test_fallback_when_no_provider(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """When managed:kimi-code provider is missing, should fallback."""
        app = _make_shell_app(runtime, tmp_path)

        open_mock = Mock(return_value=True)
        monkeypatch.setattr("webbrowser.open", open_mock)

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        open_mock.assert_called_once()

    async def test_fallback_when_no_oauth(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """When provider exists but has no oauth, should fallback."""
        runtime.config.providers["managed:kimi-code"] = LLMProvider(
            type="kimi",
            base_url="https://api.kimi.com/coding/v1",
            api_key=SecretStr("test-api-key"),
            oauth=None,
        )
        app = _make_shell_app(runtime, tmp_path)

        open_mock = Mock(return_value=True)
        monkeypatch.setattr("webbrowser.open", open_mock)

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        open_mock.assert_called_once()


# ---------------------------------------------------------------------------
# User input
# ---------------------------------------------------------------------------


class TestFeedbackUserInput:
    @pytest.mark.parametrize("exc_type", [KeyboardInterrupt, EOFError])
    async def test_cancelled_on_interrupt(
        self, runtime: Runtime, tmp_path: Path, monkeypatch, exc_type: type
    ) -> None:
        _setup_feedback_provider(runtime)
        app = _make_shell_app(runtime, tmp_path)

        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)
        monkeypatch.setattr(
            "prompt_toolkit.PromptSession.prompt_async",
            AsyncMock(side_effect=exc_type),
        )

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        assert any("cancelled" in str(call) for call in print_mock.call_args_list)

    async def test_empty_feedback_rejected(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        _setup_feedback_provider(runtime)
        app = _make_shell_app(runtime, tmp_path)

        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)
        monkeypatch.setattr(
            "prompt_toolkit.PromptSession.prompt_async",
            AsyncMock(return_value="   "),
        )

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        assert any("empty" in str(call) for call in print_mock.call_args_list)


# ---------------------------------------------------------------------------
# Submission: success & failure
# ---------------------------------------------------------------------------


class TestFeedbackSubmission:
    async def test_successful_submission(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        _setup_feedback_provider(runtime)
        app = _make_shell_app(runtime, tmp_path)

        mock_session_factory = _mock_client_session(response_status=204)
        print_mock, _ = _setup_submission_mocks(
            monkeypatch, feedback_text="Great tool!", session_factory=mock_session_factory
        )

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        # Verify success message
        assert any("submitted" in str(call) for call in print_mock.call_args_list)

        # Verify request URL
        mock_session = await mock_session_factory.return_value.__aenter__()
        post_call = mock_session.post.call_args
        assert post_call.args[0] == "https://api.kimi.com/coding/v1/feedback"

        # Verify custom_headers are included
        headers = post_call.kwargs["headers"]
        assert headers["x-canary-kfc"] == "always"
        assert "Authorization" in headers

        # Verify payload fields
        payload = post_call.kwargs["json"]
        assert payload["content"] == "Great tool!"
        assert payload["session_id"] == runtime.session.id
        assert "version" in payload
        assert "os" in payload
        assert "model" in payload

    async def test_timeout_fallback(self, runtime: Runtime, tmp_path: Path, monkeypatch) -> None:
        _setup_feedback_provider(runtime)
        app = _make_shell_app(runtime, tmp_path)

        mock_session_factory = _mock_client_session(side_effect=TimeoutError("timed out"))
        print_mock, open_mock = _setup_submission_mocks(
            monkeypatch, session_factory=mock_session_factory
        )

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        assert any("timed out" in str(call) for call in print_mock.call_args_list)
        open_mock.assert_called_once()

    async def test_client_error_with_status_fallback(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        _setup_feedback_provider(runtime)
        app = _make_shell_app(runtime, tmp_path)

        error = aiohttp.ClientResponseError(
            request_info=Mock(), history=(), status=500, message="Internal Server Error"
        )
        mock_session_factory = _mock_client_session(side_effect=error)
        print_mock, open_mock = _setup_submission_mocks(
            monkeypatch, session_factory=mock_session_factory
        )

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        assert any("HTTP 500" in str(call) for call in print_mock.call_args_list)
        open_mock.assert_called_once()

    async def test_network_error_fallback(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        _setup_feedback_provider(runtime)
        app = _make_shell_app(runtime, tmp_path)

        error = aiohttp.ClientConnectionError("connection refused")
        mock_session_factory = _mock_client_session(side_effect=error)
        print_mock, open_mock = _setup_submission_mocks(
            monkeypatch, session_factory=mock_session_factory
        )

        ret = shell_slash.feedback(cast(Shell, app), "")
        if isinstance(ret, Awaitable):
            await ret

        assert any("Network error" in str(call) for call in print_mock.call_args_list)
        open_mock.assert_called_once()
