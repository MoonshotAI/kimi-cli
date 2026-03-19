from unittest.mock import MagicMock, patch

import acp
import pytest

from kimi_cli.acp.server import ACPServer


class TestInitialize:
    """Test ACPServer.initialize method with various sys.argv scenarios."""

    @pytest.mark.asyncio
    async def test_initialize_with_kimi_command(self) -> None:
        """Test initialize when sys.argv[0] ends with 'kimi'."""
        server = ACPServer()
        with patch("sys.argv", ["kimi", "acp"]):
            response = await server.initialize(protocol_version=1)

        assert response.protocol_version == 1
        assert len(response.auth_methods) == 1
        # When command is 'kimi', args should be empty
        terminal_auth = response.auth_methods[0].field_meta.get("terminal-auth", {})
        assert terminal_auth.get("args") == ["login"]

    @pytest.mark.asyncio
    async def test_initialize_with_kimi_in_argv(self) -> None:
        """Test initialize when 'kimi' appears in sys.argv (e.g., python -m kimi_cli)."""
        server = ACPServer()
        with patch("sys.argv", ["python", "-m", "kimi", "acp"]):
            response = await server.initialize(protocol_version=1)

        assert response.protocol_version == 1
        terminal_auth = response.auth_methods[0].field_meta.get("terminal-auth", {})
        # Should extract args up to and including 'kimi'
        assert terminal_auth.get("args") == ["-m", "kimi", "login"]

    @pytest.mark.asyncio
    async def test_initialize_without_kimi_in_argv(self) -> None:
        """Test initialize when 'kimi' is NOT in sys.argv - should not crash.

        This was a bug where sys.argv.index('kimi') raised ValueError when
        ACP was started in certain ways (e.g., via IDE integration).
        """
        server = ACPServer()
        with patch("sys.argv", ["python", "-m", "kimi_cli", "acp"]):
            # Should not raise ValueError
            response = await server.initialize(protocol_version=1)

        assert response.protocol_version == 1
        assert len(response.auth_methods) == 1
        # When 'kimi' is not found, args should default to empty list
        terminal_auth = response.auth_methods[0].field_meta.get("terminal-auth", {})
        assert terminal_auth.get("args") == ["login"]


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
