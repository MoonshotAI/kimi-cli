from unittest.mock import MagicMock, patch

import acp
import pytest

from kimi_cli.acp.server import ACPServer


def _make_config(provider_type: str | None = "kimi") -> MagicMock:
    """Build a mock config with a default model pointing to a provider of the given type."""
    config = MagicMock()
    if provider_type is None:
        config.models.get.return_value = None
    else:
        model = MagicMock()
        model.provider = "test-provider"
        config.models.get.return_value = model
        provider = MagicMock()
        provider.type = provider_type
        config.providers.get.return_value = provider
    config.default_model = "default"
    return config


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


def test_check_auth_skips_when_non_kimi_provider(server: ACPServer) -> None:
    """Test that _check_auth returns early without checking tokens for non-kimi providers."""
    with patch("kimi_cli.acp.server.load_config", return_value=_make_config("openai_legacy")):
        with patch("kimi_cli.acp.server.load_tokens", return_value=None) as mock_load_tokens:
            # Should not raise even though there's no token
            server._check_auth()
            mock_load_tokens.assert_not_called()


def test_check_auth_skips_when_anthropic_provider(server: ACPServer) -> None:
    """Test that _check_auth returns early for anthropic provider type."""
    with patch("kimi_cli.acp.server.load_config", return_value=_make_config("anthropic")):
        with patch("kimi_cli.acp.server.load_tokens", return_value=None) as mock_load_tokens:
            server._check_auth()
            mock_load_tokens.assert_not_called()


def test_check_auth_enforces_kimi_auth_when_kimi_provider(server: ACPServer) -> None:
    """Test that _check_auth still requires Kimi auth when provider type is kimi."""
    with patch("kimi_cli.acp.server.load_config", return_value=_make_config("kimi")):
        with patch("kimi_cli.acp.server.load_tokens", return_value=None):
            with pytest.raises(acp.RequestError) as exc_info:
                server._check_auth()
            assert exc_info.value.code == -32000


def test_check_auth_enforces_kimi_auth_when_no_default_model(server: ACPServer) -> None:
    """Test that _check_auth still requires Kimi auth when no default model is configured."""
    with patch("kimi_cli.acp.server.load_config", return_value=_make_config(None)):
        with patch("kimi_cli.acp.server.load_tokens", return_value=None):
            with pytest.raises(acp.RequestError) as exc_info:
                server._check_auth()
            assert exc_info.value.code == -32000


def test_check_auth_raises_when_no_token(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when no token exists."""
    with patch("kimi_cli.acp.server.load_config", return_value=_make_config("kimi")):
        with patch("kimi_cli.acp.server.load_tokens", return_value=None):
            with pytest.raises(acp.RequestError) as exc_info:
                server._check_auth()

            assert exc_info.value.code == -32000  # AUTH_REQUIRED error code


def test_check_auth_raises_when_token_has_no_access_token(server: ACPServer) -> None:
    """Test that _check_auth raises AUTH_REQUIRED when token has no access_token."""
    mock_token = MagicMock()
    mock_token.access_token = None

    with patch("kimi_cli.acp.server.load_config", return_value=_make_config("kimi")):
        with patch("kimi_cli.acp.server.load_tokens", return_value=mock_token):
            with pytest.raises(acp.RequestError) as exc_info:
                server._check_auth()

            assert exc_info.value.code == -32000


def test_check_auth_passes_when_valid_token(server: ACPServer) -> None:
    """Test that _check_auth passes when a valid token exists."""
    mock_token = MagicMock()
    mock_token.access_token = "valid_token_123"

    with patch("kimi_cli.acp.server.load_config", return_value=_make_config("kimi")):
        with patch("kimi_cli.acp.server.load_tokens", return_value=mock_token):
            # Should not raise
            server._check_auth()
