"""Tests for authentication error (401) handling across wire server and ACP layers.

Verifies that when the LLM provider returns a 401 "incorrect API KEY" error,
the system surfaces a user-friendly re-login message rather than the raw API
error, through both the wire protocol and ACP protocol paths.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Self
from unittest.mock import AsyncMock, MagicMock

import acp
import pytest
from kosong.chat_provider import (
    APIStatusError,
    ChatProviderError,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.message import Message
from kosong.message import TextPart as MessageTextPart
from kosong.tooling import Tool
from kosong.tooling.simple import SimpleToolset
from pydantic import SecretStr

from kimi_cli.acp.session import ACPSession
from kimi_cli.config import LLMProvider, OAuthRef
from kimi_cli.llm import LLM
from kimi_cli.soul import run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorResponse,
    JSONRPCPromptMessage,
    JSONRPCSuccessResponse,
)
from kimi_cli.wire.server import WireServer

# ---------------------------------------------------------------------------
# Fake chat providers
# ---------------------------------------------------------------------------


class StaticStreamedMessage:
    def __init__(self, parts: Sequence[StreamedMessagePart]) -> None:
        self._iter = self._to_stream(parts)

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        return await self._iter.__anext__()

    async def _to_stream(
        self, parts: Sequence[StreamedMessagePart]
    ) -> AsyncIterator[StreamedMessagePart]:
        for part in parts:
            yield part

    @property
    def id(self) -> str | None:
        return "test"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class Auth401Provider:
    """A provider that always returns 401 Unauthorized."""

    name = "auth-401"

    @property
    def model_name(self) -> str:
        return "auth-401"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        raise APIStatusError(401, "incorrect API KEY")

    def on_retryable_error(self, error: BaseException) -> bool:
        return False

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class APIStatusErrorProvider:
    """A provider that raises APIStatusError with a configurable status code."""

    name = "api-status-error"

    def __init__(self, status_code: int, message: str) -> None:
        self._status_code = status_code
        self._message = message

    @property
    def model_name(self) -> str:
        return f"api-status-error-{self._status_code}"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        raise APIStatusError(self._status_code, self._message)

    def on_retryable_error(self, error: BaseException) -> bool:
        return False

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class GenericErrorProvider:
    """A provider that raises a generic ChatProviderError."""

    name = "generic-error"

    @property
    def model_name(self) -> str:
        return "generic-error"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        raise ChatProviderError("something went wrong")

    def on_retryable_error(self, error: BaseException) -> bool:
        return False

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class SuccessProvider:
    """A provider that returns a successful response."""

    name = "success"

    @property
    def model_name(self) -> str:
        return "success"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        return StaticStreamedMessage([MessageTextPart(text="hello")])

    def on_retryable_error(self, error: BaseException) -> bool:
        return False

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class SSLErrorProvider:
    """A provider that raises ssl.SSLError (not in _handle_prompt's catch list)."""

    name = "ssl-error"

    @property
    def model_name(self) -> str:
        return "ssl-error"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> None:
        import ssl

        raise ssl.SSLError(1, "[SSL] record layer failure (_ssl.c:2657)")

    def on_retryable_error(self, error: BaseException) -> bool:
        return False

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class ConnectionErrorProvider:
    """A provider that raises ConnectionError."""

    name = "conn-error"

    @property
    def model_name(self) -> str:
        return "conn-error"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> None:
        raise ConnectionError("Connection reset by peer")

    def on_retryable_error(self, error: BaseException) -> bool:
        return False

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_OAUTH_PROVIDER_CONFIG = LLMProvider(
    type="kimi",
    base_url="https://api.test/v1",
    api_key=SecretStr(""),
    oauth=OAuthRef(storage="file", key="oauth/kimi-code"),
)

_API_KEY_PROVIDER_CONFIG = LLMProvider(
    type="openai_legacy",
    base_url="https://api.openai.com/v1",
    api_key=SecretStr("sk-test"),
)


def _runtime_with_provider(runtime: Runtime, provider, *, oauth: bool = False) -> Runtime:
    llm = LLM(
        chat_provider=provider,
        max_context_size=100_000,
        capabilities=set(),
        provider_config=_OAUTH_PROVIDER_CONFIG if oauth else _API_KEY_PROVIDER_CONFIG,
    )
    return Runtime(
        config=runtime.config,
        llm=llm,
        session=runtime.session,
        builtin_args=runtime.builtin_args,
        denwa_renji=runtime.denwa_renji,
        approval=runtime.approval,
        labor_market=runtime.labor_market,
        environment=runtime.environment,
        notifications=runtime.notifications,
        background_tasks=runtime.background_tasks,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
        skills_dirs=runtime.skills_dirs,
        role=runtime.role,
    )


def _make_soul(runtime: Runtime, provider, tmp_path: Path, *, oauth: bool = False) -> KimiSoul:
    rt = _runtime_with_provider(runtime, provider, oauth=oauth)
    agent = Agent(
        name="Auth Error Test Agent",
        system_prompt="Test prompt.",
        toolset=SimpleToolset(),
        runtime=rt,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


async def _drain_ui_messages(wire: Wire) -> None:
    wire_ui = wire.ui_side(merge=True)
    while True:
        try:
            await wire_ui.receive()
        except QueueShutDown:
            return


# ---------------------------------------------------------------------------
# Tests: run_soul propagation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_401_propagates_as_api_status_error(runtime: Runtime, tmp_path: Path) -> None:
    """A 401 from the provider should propagate as APIStatusError through run_soul."""
    soul = _make_soul(runtime, Auth401Provider(), tmp_path)

    with pytest.raises(APIStatusError) as exc_info:
        await run_soul(soul, "hello", _drain_ui_messages, asyncio.Event())

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_403_propagates_as_api_status_error(runtime: Runtime, tmp_path: Path) -> None:
    """Non-401 status errors should still propagate as APIStatusError."""
    soul = _make_soul(runtime, APIStatusErrorProvider(403, "permission denied"), tmp_path)

    with pytest.raises(APIStatusError) as exc_info:
        await run_soul(soul, "hello", _drain_ui_messages, asyncio.Event())

    assert exc_info.value.status_code == 403


# ---------------------------------------------------------------------------
# Tests: wire server _handle_prompt
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wire_server_returns_auth_expired_for_401_with_oauth(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Wire server should return AUTH_EXPIRED for 401 when using an OAuth provider."""
    soul = _make_soul(runtime, Auth401Provider(), tmp_path, oauth=True)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.AUTH_EXPIRED
    assert "login" in response.error.message.lower()


@pytest.mark.asyncio
async def test_wire_server_returns_chat_provider_error_for_401_without_oauth(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Wire server should return CHAT_PROVIDER_ERROR (not AUTH_EXPIRED) for 401
    when using a non-OAuth provider (e.g. OpenAI API key), since "/login" would
    be misleading.
    """
    soul = _make_soul(runtime, Auth401Provider(), tmp_path, oauth=False)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.CHAT_PROVIDER_ERROR
    assert response.error.code != ErrorCodes.AUTH_EXPIRED


@pytest.mark.asyncio
async def test_wire_server_returns_chat_provider_error_for_403(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Wire server should return CHAT_PROVIDER_ERROR for non-401 status errors."""
    soul = _make_soul(runtime, APIStatusErrorProvider(403, "permission denied"), tmp_path)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.CHAT_PROVIDER_ERROR
    assert "permission denied" in response.error.message.lower()


@pytest.mark.asyncio
async def test_wire_server_returns_chat_provider_error_for_500(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Wire server should return CHAT_PROVIDER_ERROR (not AUTH_EXPIRED) for 500 errors."""
    soul = _make_soul(runtime, APIStatusErrorProvider(500, "internal server error"), tmp_path)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.CHAT_PROVIDER_ERROR
    assert response.error.code != ErrorCodes.AUTH_EXPIRED


@pytest.mark.asyncio
async def test_wire_server_returns_chat_provider_error_for_generic(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Wire server should return CHAT_PROVIDER_ERROR for generic ChatProviderError."""
    soul = _make_soul(runtime, GenericErrorProvider(), tmp_path)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.CHAT_PROVIDER_ERROR


@pytest.mark.asyncio
async def test_wire_server_returns_success_for_normal_prompt(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Wire server should return success for a prompt that completes normally."""
    soul = _make_soul(runtime, SuccessProvider(), tmp_path)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCSuccessResponse)


# ---------------------------------------------------------------------------
# Tests: ACP session prompt error handling
# ---------------------------------------------------------------------------


def _make_acp_session_with_error(error: BaseException, *, oauth: bool = True) -> ACPSession:
    """Create an ACPSession whose cli.run() raises the given error."""

    async def _failing_run(*args, **kwargs):
        raise error
        yield  # pragma: no cover — needed for async generator type

    mock_llm = MagicMock()
    mock_llm.provider_config = _OAUTH_PROVIDER_CONFIG if oauth else _API_KEY_PROVIDER_CONFIG

    mock_runtime = MagicMock()
    mock_runtime.llm = mock_llm

    mock_soul = MagicMock()
    mock_soul.runtime = mock_runtime

    mock_cli = MagicMock()
    mock_cli.run = _failing_run
    mock_cli.soul = mock_soul

    mock_conn = AsyncMock()
    return ACPSession(id="test-session", cli=mock_cli, acp_conn=mock_conn)


@pytest.mark.asyncio
async def test_acp_session_returns_auth_required_for_401_with_oauth() -> None:
    """ACP session should raise auth_required for 401 when using OAuth provider."""
    session = _make_acp_session_with_error(APIStatusError(401, "incorrect API KEY"), oauth=True)

    with pytest.raises(acp.RequestError) as exc_info:
        await session.prompt([acp.schema.TextContentBlock(type="text", text="hello")])

    assert exc_info.value.code == -32000  # AUTH_REQUIRED


@pytest.mark.asyncio
async def test_acp_session_returns_internal_error_for_401_without_oauth() -> None:
    """ACP session should raise internal_error for 401 when using API key provider."""
    session = _make_acp_session_with_error(APIStatusError(401, "incorrect API KEY"), oauth=False)

    with pytest.raises(acp.RequestError) as exc_info:
        await session.prompt([acp.schema.TextContentBlock(type="text", text="hello")])

    assert exc_info.value.code != -32000  # NOT auth_required


# ---------------------------------------------------------------------------
# Tests: _handle_prompt fallback for uncaught exceptions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wire_server_catches_ssl_error(runtime: Runtime, tmp_path: Path) -> None:
    """SSLError should be caught by the fallback except clause and return
    INTERNAL_ERROR instead of escaping and leaving the session busy forever.
    """
    soul = _make_soul(runtime, SSLErrorProvider(), tmp_path)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.INTERNAL_ERROR
    assert "SSLError" in response.error.message


@pytest.mark.asyncio
async def test_wire_server_catches_connection_error(runtime: Runtime, tmp_path: Path) -> None:
    """ConnectionError should be caught by the fallback except clause."""
    soul = _make_soul(runtime, ConnectionErrorProvider(), tmp_path)
    server = WireServer(soul)

    response = await server._handle_prompt(
        JSONRPCPromptMessage(
            id="1",
            params=JSONRPCPromptMessage.Params(user_input="hello"),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.INTERNAL_ERROR
    assert "ConnectionError" in response.error.message
