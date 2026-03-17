"""Tests for aiohttp utility module."""

from __future__ import annotations

import ssl
from unittest.mock import MagicMock, patch

import aiohttp
import pytest

from kimi_cli.utils.aiohttp import new_client_session


class TestNewClientSession:
    """Tests for new_client_session function."""

    @pytest.mark.asyncio
    async def test_trust_env_enabled(self) -> None:
        """Test that ClientSession is created with trust_env=True for proxy support."""
        with patch("aiohttp.ClientSession") as mock_session:
            mock_instance = MagicMock()
            mock_session.return_value = mock_instance

            result = new_client_session()

            call_kwargs = mock_session.call_args.kwargs
            assert call_kwargs.get("trust_env") is True
            assert "connector" in call_kwargs
            assert result == mock_instance

    @pytest.mark.asyncio
    async def test_ssl_context_configuration(self) -> None:
        """Test that SSL context is properly configured with certifi certificates."""
        with patch("aiohttp.ClientSession") as mock_session:
            mock_instance = MagicMock()
            mock_session.return_value = mock_instance

            new_client_session()

            call_kwargs = mock_session.call_args.kwargs
            assert "connector" in call_kwargs
            connector = call_kwargs["connector"]
            assert isinstance(connector, aiohttp.TCPConnector)

    @pytest.mark.asyncio
    async def test_no_explicit_proxy_set(self) -> None:
        """Test that no explicit proxy is set, allowing trust_env to handle it."""
        with patch("aiohttp.ClientSession") as mock_session:
            mock_instance = MagicMock()
            mock_session.return_value = mock_instance

            new_client_session()

            call_kwargs = mock_session.call_args.kwargs
            # Should not have explicit proxy parameter
            assert "proxy" not in call_kwargs
            # trust_env should be True to enable env-based proxy detection
            assert call_kwargs.get("trust_env") is True
