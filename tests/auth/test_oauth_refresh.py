"""Tests for OAuth token refresh: retry with backoff and force refresh."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
from pydantic import SecretStr

from kimi_cli.auth.oauth import (
    OAuthError,
    OAuthManager,
    OAuthToken,
    OAuthUnauthorized,
    refresh_token,
)
from kimi_cli.config import Config, LLMModel, LLMProvider, OAuthRef, Services

# ── helpers ──────────────────────────────────────────────────────


def _make_token(
    *,
    expires_in: float = 900,
    access: str = "access-123",
    refresh: str = "refresh-123",
) -> OAuthToken:
    return OAuthToken(
        access_token=access,
        refresh_token=refresh,
        expires_at=time.time() + expires_in,
        scope="kimi-code",
        token_type="Bearer",
    )


def _make_config() -> Config:
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr(""),
        oauth=OAuthRef(storage="file", key="oauth/kimi-code"),
    )
    model = LLMModel(provider="managed:kimi-code", model="test-model", max_context_size=100_000)
    return Config(
        default_model="managed:kimi-code/test-model",
        providers={"managed:kimi-code": provider},
        models={"managed:kimi-code/test-model": model},
        services=Services(),
    )


def _make_manager(token: OAuthToken | None = None) -> OAuthManager:
    with patch("kimi_cli.auth.oauth.load_tokens", return_value=token):
        return OAuthManager(_make_config())


# ── refresh_token retry on network errors ──────────────────────


@pytest.mark.asyncio
async def test_refresh_token_retries_on_network_error():
    """refresh_token should retry up to max_retries on transient network errors."""
    mock_response = MagicMock()
    mock_response.status = 200
    mock_response.json = AsyncMock(
        return_value={
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 900,
            "scope": "kimi-code",
            "token_type": "Bearer",
        }
    )

    call_count = 0

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def post(self, *args, **kwargs):
            return FakeContext()

    class FakeContext:
        async def __aenter__(self):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise aiohttp.ClientError("Connection reset")
            return mock_response

        async def __aexit__(self, *args):
            pass

    with patch("kimi_cli.auth.oauth.new_client_session", return_value=FakeSession()):
        result = await refresh_token("old-refresh", max_retries=3)

    assert result.access_token == "new-access"
    assert call_count == 3  # Failed twice, succeeded third time


@pytest.mark.asyncio
async def test_refresh_token_does_not_retry_on_unauthorized():
    """OAuthUnauthorized should not be retried."""

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def post(self, *args, **kwargs):
            return FakeContext()

    class FakeContext:
        async def __aenter__(self):
            mock_resp = MagicMock()
            mock_resp.status = 401
            mock_resp.json = AsyncMock(return_value={"error_description": "Token revoked"})
            return mock_resp

        async def __aexit__(self, *args):
            pass

    with (
        patch("kimi_cli.auth.oauth.new_client_session", return_value=FakeSession()),
        pytest.raises(OAuthUnauthorized, match="Token revoked"),
    ):
        await refresh_token("bad-refresh", max_retries=3)


@pytest.mark.asyncio
async def test_refresh_token_raises_after_all_retries_exhausted():
    """After max_retries network failures, should raise OAuthError."""

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def post(self, *args, **kwargs):
            return FakeContext()

    class FakeContext:
        async def __aenter__(self):
            raise aiohttp.ClientError("Network down")

        async def __aexit__(self, *args):
            pass

    with (
        patch("kimi_cli.auth.oauth.new_client_session", return_value=FakeSession()),
        pytest.raises(OAuthError, match="after retries"),
    ):
        await refresh_token("some-refresh", max_retries=2)


# ── force refresh ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ensure_fresh_force_bypasses_threshold():
    """force=True should refresh even when token has plenty of time left."""
    token = _make_token(expires_in=800)  # 13+ minutes remaining
    manager = _make_manager(token)

    mock_refresh = AsyncMock(return_value=_make_token())

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch("kimi_cli.auth.oauth.refresh_token", mock_refresh),
        patch("kimi_cli.auth.oauth.save_tokens"),
    ):
        await manager.ensure_fresh(force=True)

    mock_refresh.assert_called_once()
