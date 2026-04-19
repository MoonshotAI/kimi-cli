"""Tests for OAuthManager: resolve_api_key and ensure_fresh behavior."""

import time
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import SecretStr

from kimi_cli.auth.oauth import OAuthManager, OAuthToken
from kimi_cli.config import Config, LLMModel, LLMProvider, OAuthRef, Services


def _make_config(*, with_oauth: bool = True) -> Config:
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr(""),
        oauth=OAuthRef(storage="file", key="oauth/kimi-code") if with_oauth else None,
    )
    model = LLMModel(provider="managed:kimi-code", model="test-model", max_context_size=100_000)
    return Config(
        default_model="managed:kimi-code/test-model",
        providers={"managed:kimi-code": provider},
        models={"managed:kimi-code/test-model": model},
        services=Services(),
    )


def _make_oauth_manager(config: Config, initial_token: OAuthToken | None = None) -> OAuthManager:
    """Create an OAuthManager with mocked disk I/O."""
    with patch("kimi_cli.auth.oauth.load_tokens", return_value=initial_token):
        return OAuthManager(config)


def test_resolve_api_key_returns_oauth_token_when_available():
    config = _make_config(with_oauth=True)
    token = OAuthToken(
        access_token="oauth-access-123",
        refresh_token="refresh-123",
        expires_at=0.0,
        scope="",
        token_type="Bearer",
    )
    oauth = _make_oauth_manager(config, initial_token=token)

    ref = OAuthRef(storage="file", key="oauth/kimi-code")
    result = oauth.resolve_api_key(SecretStr(""), ref)

    assert result == "oauth-access-123"


def test_resolve_api_key_falls_back_to_api_key_when_no_token():
    config = _make_config(with_oauth=True)
    oauth = _make_oauth_manager(config, initial_token=None)
    ref = OAuthRef(storage="file", key="oauth/kimi-code")

    with patch("kimi_cli.auth.oauth.load_tokens", return_value=None):
        result = oauth.resolve_api_key(SecretStr("fallback-key"), ref)

    assert result == "fallback-key"


def test_resolve_api_key_no_warning_without_oauth_ref():
    """When oauth ref is None, no warning should be emitted."""
    config = _make_config(with_oauth=False)
    oauth = _make_oauth_manager(config)

    result = oauth.resolve_api_key(SecretStr("my-api-key"), None)

    assert result == "my-api-key"


def test_resolve_api_key_falls_back_when_token_has_empty_access_token():
    """Token loaded but access_token is empty should trigger fallback."""
    config = _make_config(with_oauth=True)
    empty_token = OAuthToken(
        access_token="",
        refresh_token="refresh-123",
        expires_at=0.0,
        scope="",
        token_type="Bearer",
    )
    oauth = _make_oauth_manager(config, initial_token=empty_token)
    ref = OAuthRef(storage="file", key="oauth/kimi-code")

    with patch("kimi_cli.auth.oauth.load_tokens", return_value=empty_token):
        result = oauth.resolve_api_key(SecretStr("fallback"), ref)

    assert result == "fallback"


# ---------------------------------------------------------------------------
# ensure_fresh() with runtime=None
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ensure_fresh_without_runtime_caches_token():
    """ensure_fresh(runtime=None) should load and cache the token without
    requiring a Runtime — used by title generation and other lightweight callers.
    """
    config = _make_config(with_oauth=True)
    oauth = _make_oauth_manager(config, initial_token=None)

    fresh_token = OAuthToken(
        access_token="fresh-access-token",
        refresh_token="refresh-123",
        expires_at=time.time() + 3600,
        scope="",
        token_type="Bearer",
    )

    with patch("kimi_cli.auth.oauth.load_tokens", return_value=fresh_token):
        await oauth.ensure_fresh()  # no runtime

    # After ensure_fresh, resolve_api_key should return the cached token
    ref = OAuthRef(storage="file", key="oauth/kimi-code")
    result = oauth.resolve_api_key(SecretStr(""), ref)
    assert result == "fresh-access-token"


@pytest.mark.asyncio
async def test_ensure_fresh_without_runtime_refreshes_expired_token():
    """ensure_fresh(runtime=None) should refresh an expired token and update
    the internal cache, so the next resolve_api_key returns the new token.
    """
    config = _make_config(with_oauth=True)
    oauth = _make_oauth_manager(config, initial_token=None)

    expired_token = OAuthToken(
        access_token="expired-access",
        refresh_token="refresh-123",
        expires_at=time.time() - 100,  # expired
        scope="",
        token_type="Bearer",
    )
    refreshed_token = OAuthToken(
        access_token="refreshed-access",
        refresh_token="new-refresh",
        expires_at=time.time() + 3600,
        scope="",
        token_type="Bearer",
    )

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=expired_token),
        patch(
            "kimi_cli.auth.oauth.refresh_token",
            new_callable=AsyncMock,
            return_value=refreshed_token,
        ),
        patch("kimi_cli.auth.oauth.save_tokens"),
    ):
        await oauth.ensure_fresh()  # no runtime — should still refresh

    ref = OAuthRef(storage="file", key="oauth/kimi-code")
    result = oauth.resolve_api_key(SecretStr(""), ref)
    assert result == "refreshed-access"


@pytest.mark.asyncio
async def test_ensure_fresh_with_no_oauth_ref_is_noop():
    """ensure_fresh() should be a no-op when no OAuth ref is configured."""
    config = _make_config(with_oauth=False)
    oauth = _make_oauth_manager(config)

    # Should not raise or do anything
    await oauth.ensure_fresh()
