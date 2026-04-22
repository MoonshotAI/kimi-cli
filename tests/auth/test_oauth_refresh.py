"""Tests for OAuth token refresh: retry with backoff and force refresh."""

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
from pydantic import SecretStr

from kimi_cli.auth.oauth import (
    _REJECTED_REFRESH_TOKENS,
    OAuthError,
    OAuthManager,
    OAuthToken,
    OAuthUnauthorized,
    _refresh_threshold,
    _save_to_file,
    refresh_token,
)
from kimi_cli.config import Config, LLMModel, LLMProvider, OAuthRef, Services

# ── helpers ──────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clear_rejected_refresh_tokens():
    _REJECTED_REFRESH_TOKENS.clear()
    yield
    _REJECTED_REFRESH_TOKENS.clear()


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


@pytest.mark.asyncio
async def test_refresh_token_retries_on_5xx():
    """refresh_token should retry when the auth server returns 502/503."""
    ok_response = MagicMock()
    ok_response.status = 200
    ok_response.json = AsyncMock(
        return_value={
            "access_token": "recovered",
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
            resp = MagicMock()
            if call_count < 3:
                resp.status = 502
                resp.json = AsyncMock(return_value={})
                return resp
            return ok_response

        async def __aexit__(self, *args):
            pass

    with patch("kimi_cli.auth.oauth.new_client_session", return_value=FakeSession()):
        result = await refresh_token("old-refresh", max_retries=3)

    assert result.access_token == "recovered"
    assert call_count == 3


@pytest.mark.asyncio
async def test_refresh_token_does_not_retry_on_400():
    """Non-retryable HTTP errors (e.g. 400) should fail immediately."""

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def post(self, *args, **kwargs):
            return FakeContext()

    class FakeContext:
        async def __aenter__(self):
            resp = MagicMock()
            resp.status = 400
            resp.json = AsyncMock(return_value={"error_description": "invalid_grant"})
            return resp

        async def __aexit__(self, *args):
            pass

    with (
        patch("kimi_cli.auth.oauth.new_client_session", return_value=FakeSession()),
        pytest.raises(OAuthError, match="invalid_grant"),
    ):
        await refresh_token("bad-refresh", max_retries=3)


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


# ── dynamic threshold ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_ensure_fresh_uses_dynamic_threshold():
    """When expires_in is large, threshold should be expires_in * RATIO."""
    # Token with 1800s total lifetime; dynamic threshold = 1800 * 0.5 = 900.
    # Remaining 850s < 900 => should trigger refresh.
    token = _make_token(expires_in=1800)
    token.expires_at = time.time() + 850  # simulate time passing
    manager = _make_manager(token)

    mock_refresh = AsyncMock(return_value=_make_token())

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch("kimi_cli.auth.oauth.refresh_token", mock_refresh),
        patch("kimi_cli.auth.oauth.save_tokens"),
    ):
        await manager.ensure_fresh()

    mock_refresh.assert_called_once()


@pytest.mark.asyncio
async def test_ensure_fresh_skips_when_plenty_of_time():
    """When remaining time exceeds the dynamic threshold, skip refresh."""
    # Token with 1800s total lifetime; dynamic threshold = 1800 * 0.5 = 900.
    # Remaining 1000s > 900 => should NOT trigger refresh.
    token = _make_token(expires_in=1800)
    token.expires_at = time.time() + 1000  # plenty of time
    manager = _make_manager(token)

    mock_refresh = AsyncMock(return_value=_make_token())

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch("kimi_cli.auth.oauth.refresh_token", mock_refresh),
        patch("kimi_cli.auth.oauth.save_tokens"),
    ):
        await manager.ensure_fresh()

    mock_refresh.assert_not_called()


# ── atomic save ────────────────────────────────────────────────


def test_save_to_file_is_atomic(tmp_path):
    """_save_to_file should write atomically via rename, not in-place."""
    key = "test-atomic"
    with patch("kimi_cli.auth.oauth._credentials_dir", return_value=tmp_path):
        token = _make_token()
        _save_to_file(key, token)
        path = tmp_path / f"{key}.json"
        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["access_token"] == "access-123"
        # No leftover .tmp files
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == []


def test_save_to_file_expires_in_roundtrip(tmp_path):
    """expires_in should survive a save/load roundtrip."""
    key = "test-roundtrip"
    with patch("kimi_cli.auth.oauth._credentials_dir", return_value=tmp_path):
        token = _make_token(expires_in=7200)
        _save_to_file(key, token)
        path = tmp_path / f"{key}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        restored = OAuthToken.from_dict(data)
        assert restored.expires_in == 7200


# ── OAuthToken defaults ───────────────────────────────────────


def test_oauth_token_from_dict_defaults_expires_in():
    """from_dict should default expires_in to 0 when key is missing."""
    payload = {
        "access_token": "a",
        "refresh_token": "r",
        "expires_at": 123.0,
        "scope": "s",
        "token_type": "Bearer",
    }
    token = OAuthToken.from_dict(payload)
    assert token.expires_in == 0.0


# ── force refresh failure propagation ─────────────────────────


@pytest.mark.asyncio
async def test_ensure_fresh_force_raises_on_unauthorized():
    """force=True should propagate OAuthUnauthorized instead of swallowing it."""
    token = _make_token(expires_in=800)
    manager = _make_manager(token)

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch(
            "kimi_cli.auth.oauth.refresh_token", AsyncMock(side_effect=OAuthUnauthorized("revoked"))
        ),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
        pytest.raises(OAuthUnauthorized, match="revoked"),
    ):
        await manager.ensure_fresh(force=True)


@pytest.mark.asyncio
async def test_unauthorized_must_not_delete_credentials_file(tmp_path, monkeypatch):
    """A single 401 from the refresh endpoint must not delete the credentials
    file.  The load_tokens check above the deletion site is vulnerable to a
    TOCTOU race: a concurrent manager may write a freshly rotated token into
    the file between the check and the deletion, and wiping it would cause
    permanent auth loss even though a valid token is sitting on disk.
    """
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    _save_to_file("oauth/kimi-code", _make_token(refresh="R1", expires_in=100))
    cred = tmp_path / "credentials" / "kimi-code.json"
    assert cred.exists()

    manager = OAuthManager(_make_config())

    with (
        patch(
            "kimi_cli.auth.oauth.refresh_token",
            AsyncMock(side_effect=OAuthUnauthorized("invalid_grant")),
        ),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
        pytest.raises(OAuthUnauthorized),
    ):
        await manager.ensure_fresh(force=True)

    assert cred.exists(), (
        "credentials file was deleted on a single 401 — a concurrent "
        "manager may have just rotated the token in the TOCTOU window"
    )
    assert manager._access_tokens.get("oauth/kimi-code") is None, (
        "in-memory access token cache must still be cleared after 401"
    )


@pytest.mark.asyncio
async def test_unauthorized_non_force_must_not_delete_credentials_file(tmp_path, monkeypatch):
    """Same guarantee as the force=True case, but for the background-refresh
    path.  force=False swallows the exception rather than re-raising, but it
    still must not delete the credentials file on a single 401 — a concurrent
    manager may have just rotated the token.
    """
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    _save_to_file("oauth/kimi-code", _make_token(refresh="R1", expires_in=100))
    cred = tmp_path / "credentials" / "kimi-code.json"
    assert cred.exists()

    manager = OAuthManager(_make_config())

    with (
        patch(
            "kimi_cli.auth.oauth.refresh_token",
            AsyncMock(side_effect=OAuthUnauthorized("invalid_grant")),
        ),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
    ):
        # force=False: should NOT raise, just log warning and return
        await manager.ensure_fresh(force=False)

    assert cred.exists(), (
        "credentials file was deleted on a background-refresh 401 — "
        "same TOCTOU risk as the force=True case"
    )
    assert manager._access_tokens.get("oauth/kimi-code") is None, (
        "in-memory access token cache must still be cleared after 401"
    )


@pytest.mark.asyncio
async def test_rejected_refresh_token_cooldown_skips_background_retry(tmp_path, monkeypatch):
    """After a confirmed refresh 401, the same persisted refresh token should
    not be retried again immediately by the background-refresh path.
    """
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    _save_to_file("oauth/kimi-code", _make_token(refresh="R1", expires_in=100))

    manager = OAuthManager(_make_config())
    refresh = AsyncMock(side_effect=OAuthUnauthorized("invalid_grant"))

    with (
        patch("kimi_cli.auth.oauth.refresh_token", refresh),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
    ):
        with pytest.raises(OAuthUnauthorized):
            await manager.ensure_fresh(force=True)

        await manager.ensure_fresh(force=False)

    assert refresh.await_count == 1, (
        "background refresh retried the same rejected refresh token without "
        "waiting for the cooldown"
    )


@pytest.mark.asyncio
async def test_rejected_tombstone_cleared_when_concurrent_instance_rotated(tmp_path, monkeypatch):
    """If another kimi-cli instance legitimately rotates the refresh token
    after we marked the old one rejected, the tombstone must clear and the
    new token must be picked up without going to the network.
    """
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    _save_to_file("oauth/kimi-code", _make_token(refresh="R1", expires_in=100))

    manager = OAuthManager(_make_config())
    refresh = AsyncMock(side_effect=OAuthUnauthorized("invalid_grant"))

    # Step 1: hit a 401 with R1 → marks R1 rejected
    with (
        patch("kimi_cli.auth.oauth.refresh_token", refresh),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
        pytest.raises(OAuthUnauthorized),
    ):
        await manager.ensure_fresh(force=True)

    assert _REJECTED_REFRESH_TOKENS.get("oauth/kimi-code") is not None

    # Step 2: simulate a concurrent instance writing a fresh token (R2) to disk
    _save_to_file(
        "oauth/kimi-code",
        _make_token(access="new-access", refresh="R2", expires_in=900),
    )

    # Step 3: next ensure_fresh should detect the rotation, clear the
    # tombstone, and NOT call refresh_token again
    with (
        patch("kimi_cli.auth.oauth.refresh_token", refresh),
        patch("kimi_cli.auth.oauth.asyncio.sleep", new=AsyncMock()),
    ):
        await manager.ensure_fresh(force=False)

    assert refresh.await_count == 1, "should not retry refresh after rotation recovered"
    assert _REJECTED_REFRESH_TOKENS.get("oauth/kimi-code") is None, (
        "tombstone must be cleared once the on-disk refresh_token no longer matches"
    )
    assert manager._access_tokens.get("oauth/kimi-code") == "new-access", (
        "the new access token from R2 should be cached"
    )


@pytest.mark.asyncio
async def test_ensure_fresh_force_raises_on_network_error():
    """force=True should propagate network errors instead of swallowing them."""
    token = _make_token(expires_in=800)
    manager = _make_manager(token)

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch(
            "kimi_cli.auth.oauth.refresh_token", AsyncMock(side_effect=OAuthError("after retries"))
        ),
        pytest.raises(OAuthError, match="after retries"),
    ):
        await manager.ensure_fresh(force=True)


@pytest.mark.asyncio
async def test_ensure_fresh_non_force_swallows_errors():
    """Without force, refresh errors should be swallowed (background loop behavior)."""
    token = _make_token(expires_in=100)  # below threshold → triggers refresh
    token.expires_at = time.time() + 100
    manager = _make_manager(token)

    with (
        patch("kimi_cli.auth.oauth.load_tokens", return_value=token),
        patch("kimi_cli.auth.oauth.refresh_token", AsyncMock(side_effect=OAuthError("fail"))),
    ):
        # Should NOT raise — errors are swallowed in background mode
        await manager.ensure_fresh()


# ── _refresh_threshold helper ─────────────────────────────────


def test_refresh_threshold_uses_ratio_when_large():
    """When expires_in * RATIO > MIN, use the ratio-based threshold."""
    assert _refresh_threshold(1800) == 900.0  # 1800 * 0.5 = 900 > 300


def test_refresh_threshold_uses_minimum_when_small():
    """When expires_in * RATIO < MIN, use the minimum."""
    assert _refresh_threshold(500) == 300.0  # 500 * 0.5 = 250 < 300


def test_refresh_threshold_zero_expires_in():
    """When expires_in is 0, fall back to the minimum."""
    assert _refresh_threshold(0) == 300.0
