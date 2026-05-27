"""Tests for OAuthManager: resolve_api_key and ensure_fresh behavior."""

import time
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import SecretStr

from kimi_cli.auth.oauth import (
    _REJECTED_REFRESH_TOKENS,
    OAuthManager,
    OAuthToken,
    OAuthUnauthorized,
    _save_to_file,
)
from kimi_cli.config import Config, LLMModel, LLMProvider, OAuthRef, Services


@pytest.fixture(autouse=True)
def _clear_rejected_refresh_tokens():
    _REJECTED_REFRESH_TOKENS.clear()
    yield
    _REJECTED_REFRESH_TOKENS.clear()


def _make_config(*, with_oauth: bool = True, api_key: str = "") -> Config:
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr(api_key),
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


@pytest.mark.asyncio
async def test_resolve_api_key_falls_back_after_rejected_refresh_token(tmp_path, monkeypatch):
    """After a confirmed refresh 401, keep the file but stop preferring the
    same persisted OAuth token over a configured static API key.
    """
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    config = _make_config(with_oauth=True, api_key="fallback-key")
    token = OAuthToken(
        access_token="oauth-access-123",
        refresh_token="refresh-123",
        expires_at=time.time() + 100,
        scope="",
        token_type="Bearer",
        expires_in=100,
    )
    _save_to_file("oauth/kimi-code", token)

    oauth = OAuthManager(config)
    ref = OAuthRef(storage="file", key="oauth/kimi-code")

    with (
        patch(
            "kimi_cli.auth.oauth.refresh_token",
            AsyncMock(side_effect=OAuthUnauthorized("revoked")),
        ),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
        pytest.raises(OAuthUnauthorized, match="revoked"),
    ):
        await oauth.ensure_fresh(force=True)

    result = oauth.resolve_api_key(config.providers["managed:kimi-code"].api_key, ref)
    assert result == "fallback-key"


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


# ---------------------------------------------------------------------------
# _apply_access_token() key-pool gating
# ---------------------------------------------------------------------------


def test_apply_access_token_with_key_pool_but_unwrapped_provider_updates_key():
    """When key_pool exists but the root chat_provider is NOT wrapped by
    KeyPoolKimi, _apply_access_token should still update the client's api_key.
    """
    from unittest.mock import MagicMock

    from kosong.chat_provider.kimi import Kimi

    from kimi_cli.auth.platforms import KIMI_CODE_PLATFORM_ID, managed_provider_key

    config = _make_config(with_oauth=True)
    oauth = _make_oauth_manager(config, initial_token=None)

    provider_key = managed_provider_key(KIMI_CODE_PLATFORM_ID)

    # Build a mock Kimi provider with a mutable client api_key.
    # spec=Kimi is needed so isinstance(chat_provider, Kimi) passes,
    # but client is an instance attribute so we must attach it explicitly.
    chat_provider = MagicMock(spec=Kimi)
    chat_provider.client = MagicMock()
    chat_provider.client.api_key = "old-token"

    runtime = MagicMock()
    runtime.llm.model_config.provider = provider_key
    runtime.llm.chat_provider = chat_provider
    runtime.config.providers.get.return_value = None
    runtime.key_pool = MagicMock()  # pool exists but provider is unwrapped

    oauth._apply_access_token(runtime, "new-oauth-token")

    assert chat_provider.client.api_key == "new-oauth-token"


def test_apply_access_token_with_key_pool_wrapper_skips_update():
    """When the chat_provider IS wrapped by KeyPoolKimi, _apply_access_token
    should skip updating the client's api_key so the pool keeps rotating.
    """
    from unittest.mock import MagicMock

    from kosong.chat_provider.kimi import Kimi

    from kimi_cli.auth.platforms import KIMI_CODE_PLATFORM_ID, managed_provider_key
    from kimi_cli.llm import KeyPoolKimi

    config = _make_config(with_oauth=True)
    oauth = _make_oauth_manager(config, initial_token=None)

    provider_key = managed_provider_key(KIMI_CODE_PLATFORM_ID)

    inner_provider = MagicMock(spec=Kimi)
    inner_provider.client = MagicMock()
    inner_provider.client.api_key = "old-token"
    inner_provider.name = "kimi"
    inner_provider.model = "test-model"
    inner_provider.stream = True
    wrapped = KeyPoolKimi(inner_provider, MagicMock())

    runtime = MagicMock()
    runtime.llm.model_config.provider = provider_key
    runtime.llm.chat_provider = wrapped
    runtime.config.providers.get.return_value = None
    runtime.key_pool = MagicMock()

    oauth._apply_access_token(runtime, "new-oauth-token")

    # The inner provider's key must NOT be overwritten
    assert inner_provider.client.api_key == "old-token"
