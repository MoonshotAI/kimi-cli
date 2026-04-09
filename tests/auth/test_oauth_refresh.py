"""Tests for OAuth token refresh: retry, force refresh, atomic write, and 401 recovery."""

import asyncio
import json
import os
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
    _save_to_file,
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
        expires_in=expires_in,
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


# ── P2: refresh_token retry on network errors ────────────────────


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


# ── P1: dynamic refresh threshold ───────────────────────────────


@pytest.mark.asyncio
async def test_ensure_fresh_uses_dynamic_threshold():
    """Token with 7 minutes remaining and expires_in=900 should trigger refresh
    (threshold = max(300, 900*0.5) = 450s, and 420s < 450s)."""
    token = _make_token(expires_in=420)  # 7 minutes remaining
    token.expires_in = 900  # Original lifetime was 15 min

    manager = _make_manager(token)
    mock_refresh = AsyncMock()

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch.object(manager, "_refresh_lock", asyncio.Lock()),
        patch("kimi_cli.auth.oauth.refresh_token", mock_refresh),
    ):
        mock_refresh.return_value = _make_token()
        with patch("kimi_cli.auth.oauth.save_tokens"):
            await manager.ensure_fresh()

    mock_refresh.assert_called_once()


@pytest.mark.asyncio
async def test_ensure_fresh_skips_when_plenty_of_time():
    """Token with 8 minutes remaining and expires_in=900 should NOT trigger refresh
    (threshold = 450s, and 480s > 450s)."""
    token = _make_token(expires_in=480)  # 8 minutes remaining
    token.expires_in = 900

    manager = _make_manager(token)

    with patch("kimi_cli.auth.oauth.load_tokens", return_value=token):
        mock_refresh = AsyncMock()
        with patch("kimi_cli.auth.oauth.refresh_token", mock_refresh):
            await manager.ensure_fresh()

    mock_refresh.assert_not_called()


# ── P0: force refresh ───────────────────────────────────────────


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


# ── P3: atomic file write ───────────────────────────────────────


def test_save_to_file_is_atomic(tmp_path):
    """_save_to_file should write atomically via temp file + rename."""
    cred_dir = tmp_path / "credentials"
    cred_dir.mkdir()
    token = _make_token()

    with patch("kimi_cli.auth.oauth._credentials_path", return_value=cred_dir / "test.json"):
        _save_to_file("test", token)

    saved = json.loads((cred_dir / "test.json").read_text())
    assert saved["access_token"] == "access-123"
    assert saved["expires_in"] == 900

    # No temp files left behind
    assert len(list(cred_dir.glob("*.tmp"))) == 0

    # File permissions
    stat = os.stat(cred_dir / "test.json")
    assert stat.st_mode & 0o777 == 0o600


def test_save_to_file_expires_in_roundtrip(tmp_path):
    """expires_in field should survive save/load roundtrip."""
    cred_dir = tmp_path / "credentials"
    cred_dir.mkdir()
    token = _make_token(expires_in=1800)

    with patch("kimi_cli.auth.oauth._credentials_path", return_value=cred_dir / "test.json"):
        _save_to_file("test", token)

    saved = json.loads((cred_dir / "test.json").read_text())
    restored = OAuthToken.from_dict(saved)
    assert restored.expires_in == 1800


def test_oauth_token_from_dict_defaults_expires_in():
    """Tokens from older versions (no expires_in) should default to 0."""
    old_format = {
        "access_token": "a",
        "refresh_token": "r",
        "expires_at": time.time() + 100,
        "scope": "kimi-code",
        "token_type": "Bearer",
    }
    token = OAuthToken.from_dict(old_format)
    assert token.expires_in == 0
