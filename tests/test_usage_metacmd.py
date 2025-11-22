"""Tests for the /usage meta command."""

from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
from pydantic import SecretStr

from kimi_cli.config import Config, LLMModel, LLMProvider
from kimi_cli.ui.shell.metacmd import get_meta_command

# Patch locations for imports inside the usage function
LOAD_CONFIG_PATCH = "kimi_cli.config.load_config"
NEW_CLIENT_SESSION_PATCH = "kimi_cli.utils.aiohttp.new_client_session"


@pytest.fixture
def mock_app():
    """Create a mock ShellApp instance."""
    app = MagicMock()
    app.soul = MagicMock()
    return app


@pytest.fixture
def mock_config_with_model():
    """Create a mock config with a configured model."""
    return Config(
        default_model="test-model",
        models={
            "test-model": LLMModel(
                provider="test-provider",
                model="test-model",
                max_context_size=100000,
            )
        },
        providers={
            "test-provider": LLMProvider(
                type="kimi",
                base_url="https://api.test.com/v1",
                api_key=SecretStr("test-api-key"),
            )
        },
    )


@pytest.fixture
def mock_config_empty():
    """Create a mock config without any models."""
    return Config(
        default_model="",
        models={},
        providers={},
    )


@pytest.mark.asyncio
async def test_usage_command_no_model_configured(mock_app, mock_config_empty, capsys):
    """Test /usage command when no model is configured."""
    usage_cmd = get_meta_command("usage")
    assert usage_cmd is not None

    with patch("kimi_cli.config.load_config", return_value=mock_config_empty):
        await usage_cmd.func(mock_app, [])

    # The command should print an error message
    # Note: We can't easily capture Rich console output in tests,
    # but we can verify the function completes without raising exceptions


@pytest.mark.asyncio
async def test_usage_command_with_successful_response(mock_app, mock_config_with_model):
    """Test /usage command with a successful API response."""
    usage_cmd = get_meta_command("usage")
    assert usage_cmd is not None

    # Mock API response
    mock_response_data = {
        "data": {
            "total_usage": 1000,
            "total_quota": 10000,
            "reset_date": "2025-12-01",
        }
    }

    mock_response = AsyncMock()
    mock_response.status = 200
    mock_response.json = AsyncMock(return_value=mock_response_data)
    mock_response.raise_for_status = MagicMock()
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=None)

    mock_session = MagicMock()
    mock_session.get = MagicMock(return_value=mock_response)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with (
        patch(LOAD_CONFIG_PATCH, return_value=mock_config_with_model),
        patch(NEW_CLIENT_SESSION_PATCH, return_value=mock_session),
    ):
        await usage_cmd.func(mock_app, [])

    # Verify the API was called
    mock_session.get.assert_called_once()
    call_args = mock_session.get.call_args
    assert "https://api.test.com/v1/usage" in str(call_args)


@pytest.mark.asyncio
async def test_usage_command_with_404_fallback(mock_app, mock_config_with_model):
    """Test /usage command falls back to alternative endpoint on 404."""
    usage_cmd = get_meta_command("usage")
    assert usage_cmd is not None

    # Mock first response (404)
    mock_response_404 = AsyncMock()
    mock_response_404.status = 404

    # Mock second response (success)
    mock_response_data = {"usage": 500, "quota": 5000}
    mock_response_success = AsyncMock()
    mock_response_success.status = 200
    mock_response_success.json = AsyncMock(return_value=mock_response_data)
    mock_response_success.raise_for_status = MagicMock()
    mock_response_success.__aenter__ = AsyncMock(return_value=mock_response_success)
    mock_response_success.__aexit__ = AsyncMock(return_value=None)

    # First call returns 404, second call returns success
    mock_response_404.__aenter__ = AsyncMock(return_value=mock_response_404)
    mock_response_404.__aexit__ = AsyncMock(return_value=None)

    mock_session = MagicMock()
    mock_session.get = MagicMock(side_effect=[mock_response_404, mock_response_success])
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with (
        patch(LOAD_CONFIG_PATCH, return_value=mock_config_with_model),
        patch(NEW_CLIENT_SESSION_PATCH, return_value=mock_session),
    ):
        await usage_cmd.func(mock_app, [])

    # Verify both endpoints were tried
    assert mock_session.get.call_count == 2


@pytest.mark.asyncio
async def test_usage_command_with_auth_error(mock_app, mock_config_with_model):
    """Test /usage command handles authentication errors."""
    usage_cmd = get_meta_command("usage")
    assert usage_cmd is not None

    # Mock 401 response
    mock_response = AsyncMock()
    mock_response.status = 401
    mock_response.raise_for_status = MagicMock(
        side_effect=aiohttp.ClientResponseError(
            request_info=MagicMock(),
            history=(),
            status=401,
            message="Unauthorized",
        )
    )
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=None)

    mock_session = MagicMock()
    mock_session.get = MagicMock(return_value=mock_response)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with (
        patch(LOAD_CONFIG_PATCH, return_value=mock_config_with_model),
        patch(NEW_CLIENT_SESSION_PATCH, return_value=mock_session),
    ):
        await usage_cmd.func(mock_app, [])

    # Should handle the error gracefully without raising


@pytest.mark.asyncio
async def test_usage_command_with_network_error(mock_app, mock_config_with_model):
    """Test /usage command handles network errors."""
    usage_cmd = get_meta_command("usage")
    assert usage_cmd is not None

    mock_session = MagicMock()
    mock_session.get = MagicMock(side_effect=aiohttp.ClientError("Network error"))
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with (
        patch(LOAD_CONFIG_PATCH, return_value=mock_config_with_model),
        patch(NEW_CLIENT_SESSION_PATCH, return_value=mock_session),
    ):
        await usage_cmd.func(mock_app, [])

    # Should handle the error gracefully without raising


def test_usage_command_registration():
    """Test that the usage command is properly registered."""
    usage_cmd = get_meta_command("usage")

    assert usage_cmd is not None
    assert usage_cmd.name == "usage"
    assert "usage" in usage_cmd.description.lower() or "quota" in usage_cmd.description.lower()
    assert usage_cmd.kimi_soul_only is False
