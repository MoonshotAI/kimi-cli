import time
from unittest.mock import patch

import acp
import pytest

from kimi_cli.acp.server import ACPServer
from kimi_cli.auth.oauth import OAuthToken


@pytest.fixture
def server() -> ACPServer:
    """Create an ACPServer instance with mocked auth methods."""
    s = ACPServer()
    s._auth_methods = [
        acp.schema.AuthMethod(
            id="login",
            name="Test Login",
            description="Test description",
            field_meta={
                "terminal-auth": {
                    "type": "terminal",
                    "args": ["kimi", "login"],
                    "env": {},
                }
            },
        )
    ]
    return s


def _make_token(
    access_token: str = "valid_token_123",
    refresh_token: str = "refresh_123",
    expires_at: float | None = None,
) -> OAuthToken:
    if expires_at is None:
        expires_at = time.time() + 3600  # 1 hour from now
    return OAuthToken(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=expires_at,
        scope="",
        token_type="Bearer",
    )


def test_check_auth_raises_when_no_token(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when no token exists."""
    with patch("kimi_cli.acp.server.load_tokens", return_value=None):
        with pytest.raises(acp.RequestError) as exc_info:
            server._check_auth()

        assert exc_info.value.code == -32000  # AUTH_REQUIRED error code


def test_check_auth_raises_when_token_has_no_access_token(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when token has no access_token."""
    token = _make_token(access_token="")

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        with pytest.raises(acp.RequestError) as exc_info:
            server._check_auth()

        assert exc_info.value.code == -32000


def test_check_auth_passes_when_valid_token(server: ACPServer) -> None:
    """Test that _check_auth passes when a valid token exists."""
    token = _make_token()

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        # Should not raise
        server._check_auth()


def test_check_auth_raises_when_token_expired_without_refresh(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when token expired and no refresh token."""
    token = _make_token(
        expires_at=time.time() - 100,  # expired 100 seconds ago
        refresh_token="",
    )

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        with pytest.raises(acp.RequestError) as exc_info:
            server._check_auth()

        assert exc_info.value.code == -32000


def test_check_auth_passes_when_token_expired_but_has_refresh(server: ACPServer) -> None:
    """Test that _check_auth passes when token expired but refresh token is available.

    The background refresh mechanism will handle renewal.
    """
    token = _make_token(
        expires_at=time.time() - 100,  # expired
        refresh_token="refresh_123",
    )

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        # Should not raise — background refresh will handle it
        server._check_auth()


def test_check_auth_passes_when_expires_at_is_zero(server: ACPServer) -> None:
    """Test that expires_at=0 (no expiry info from server) is treated as valid.

    OAuthToken.from_dict() sets expires_at=0.0 when the response has no
    expires_at field. The code uses ``token.expires_at and ...`` so 0.0
    (falsy) skips the expiry check entirely.
    """
    token = _make_token(expires_at=0.0)

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        # Should not raise
        server._check_auth()


# ---------------------------------------------------------------------------
# authenticate() must agree with _check_auth()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_authenticate_rejects_expired_token_without_refresh(server: ACPServer) -> None:
    """authenticate('login') must reject an expired token with no refresh token,
    the same way _check_auth() does. Otherwise the client gets a false-success
    from authenticate, then immediately fails on new_session.
    """
    token = _make_token(
        expires_at=time.time() - 100,
        refresh_token="",
    )

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        with pytest.raises(acp.RequestError) as exc_info:
            await server.authenticate(method_id="login")

        assert exc_info.value.code == -32000


@pytest.mark.asyncio
async def test_authenticate_accepts_valid_token(server: ACPServer) -> None:
    """authenticate('login') should succeed for a valid, non-expired token."""
    token = _make_token()

    with patch("kimi_cli.acp.server.load_tokens", return_value=token):
        result = await server.authenticate(method_id="login")

    assert result is not None
