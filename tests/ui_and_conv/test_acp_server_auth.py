import sys
from unittest.mock import MagicMock, patch

import acp
import pytest

from kimi_cli.acp.server import ACPServer


class TestInitialize:
    """Test ACPServer.initialize method."""

    @pytest.mark.asyncio
    async def test_initialize_returns_auth_methods(self) -> None:
        """Test that initialize returns auth methods with sys.executable."""
        server = ACPServer()
        response = await server.initialize(protocol_version=1)

        assert response.protocol_version == 1
        assert len(response.auth_methods) == 1
        # Verify auth method structure
        auth_method = response.auth_methods[0]
        assert auth_method.id == "login"
        assert "terminal-auth" in auth_method.field_meta
        
        terminal_auth = auth_method.field_meta["terminal-auth"]
        assert terminal_auth.get("command") == sys.executable
        assert terminal_auth.get("args") == ["-m", "kimi_cli", "login"]
        assert terminal_auth.get("label") == "Kimi Code Login"
        assert terminal_auth.get("type") == "terminal"


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
                    "command": "kimi",
                    "args": ["login"],
                    "label": "Kimi Code Login",
                    "env": {},
                }
            },
        )
    ]
    return s


def test_check_auth_raises_when_no_token(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when no token exists."""
    with patch("kimi_cli.acp.server.load_tokens", return_value=None):
        with pytest.raises(acp.RequestError) as exc_info:
            server._check_auth()

        assert exc_info.value.code == -32000  # AUTH_REQUIRED error code


def test_check_auth_raises_when_token_has_no_access_token(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when token has no access_token."""
    mock_token = MagicMock()
    mock_token.access_token = None

    with patch("kimi_cli.acp.server.load_tokens", return_value=mock_token):
        with pytest.raises(acp.RequestError) as exc_info:
            server._check_auth()

        assert exc_info.value.code == -32000


def test_check_auth_passes_when_valid_token(server: ACPServer) -> None:
    """Test that _check_auth passes when a valid token exists."""
    mock_token = MagicMock()
    mock_token.access_token = "valid_token_123"

    with patch("kimi_cli.acp.server.load_tokens", return_value=mock_token):
        # Should not raise
        server._check_auth()