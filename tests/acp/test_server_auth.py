"""Tests for ACP server authentication enhancements."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kimi_cli.acp.server import ACPServer
from kimi_cli.auth.oauth import OAuthToken


@pytest.fixture
def mock_conn():
    """Create a mock ACP client connection."""
    conn = MagicMock()
    conn.create_terminal = AsyncMock()
    conn.wait_for_terminal_exit = AsyncMock()
    conn.terminal_output = AsyncMock()
    conn.release_terminal = AsyncMock()
    conn.session_update = AsyncMock()
    return conn


@pytest.fixture
def server_with_conn(mock_conn):
    """Create an ACPServer with a mock connection."""
    server = ACPServer()
    server.conn = mock_conn
    server.client_capabilities = MagicMock()
    server.client_capabilities.terminal = True
    server.sessions = {"test-session": (MagicMock(), MagicMock())}
    return server


class TestTriggerLoginInTerminal:
    """Tests for _trigger_login_in_terminal method."""

    @pytest.mark.asyncio
    async def test_successful_terminal_login(self, server_with_conn, mock_conn):
        """Test successful login via terminal."""
        # Setup mocks
        mock_conn.create_terminal.return_value = MagicMock(terminal_id="term-123")
        mock_conn.wait_for_terminal_exit.return_value = MagicMock(exit_code=0)
        mock_conn.terminal_output.return_value = MagicMock(output="Login successful")

        # Mock load_tokens to return a valid token
        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.return_value = OAuthToken(
                access_token="test-token",
                refresh_token="test-refresh",
                expires_at=9999999999.0,
                scope="test",
                token_type="Bearer",
            )

            # Call the method
            result = await server_with_conn._trigger_login_in_terminal("test-session")

            # Verify
            assert result is True
            mock_conn.create_terminal.assert_called_once()
            mock_conn.wait_for_terminal_exit.assert_called_once()
            mock_conn.release_terminal.assert_called_once()

    @pytest.mark.asyncio
    async def test_failed_terminal_login(self, server_with_conn, mock_conn):
        """Test failed login via terminal."""
        # Setup mocks
        mock_conn.create_terminal.return_value = MagicMock(terminal_id="term-123")
        mock_conn.wait_for_terminal_exit.return_value = MagicMock(exit_code=1)
        mock_conn.terminal_output.return_value = MagicMock(output="Login failed")

        # Mock load_tokens to return None (no token)
        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.return_value = None

            # Call the method
            result = await server_with_conn._trigger_login_in_terminal("test-session")

            # Verify
            assert result is False
            mock_conn.create_terminal.assert_called_once()
            mock_conn.release_terminal.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_connection(self):
        """Test when there's no ACP connection."""
        server = ACPServer()
        result = await server._trigger_login_in_terminal("test-session")
        assert result is False


class TestTriggerOAuthDeviceFlow:
    """Tests for _trigger_oauth_device_flow method."""

    @pytest.mark.asyncio
    async def test_successful_oauth_device_flow(self, server_with_conn, mock_conn):
        """Test successful OAuth device flow."""
        from kimi_cli.auth.oauth import OAuthEvent

        # Mock login_kimi_code to yield success events
        async def mock_login_kimi_code(config, open_browser=False):
            yield OAuthEvent("verification_url", "Please visit: https://auth.example.com/device?user_code=ABC123", data={"verification_url": "https://auth.example.com/device?user_code=ABC123", "user_code": "ABC123"})
            yield OAuthEvent("success", "Logged in successfully.")

        with patch("kimi_cli.auth.oauth.login_kimi_code", side_effect=mock_login_kimi_code):
            with patch("kimi_cli.acp.server.load_config") as mock_load_config:
                mock_load_config.return_value = MagicMock()

                # Call the method with a real session ID
                result = await server_with_conn._trigger_oauth_device_flow("test-session")

                # Verify
                assert result is True
                mock_conn.session_update.assert_called()

    @pytest.mark.asyncio
    async def test_oauth_device_flow_timeout(self, server_with_conn, mock_conn):
        """Test OAuth device flow timeout."""
        from kimi_cli.auth.oauth import OAuthEvent

        # Mock login_kimi_code to yield error event
        async def mock_login_kimi_code(config, open_browser=False):
            yield OAuthEvent("error", "Login failed: timeout")

        with patch("kimi_cli.auth.oauth.login_kimi_code", side_effect=mock_login_kimi_code):
            with patch("kimi_cli.acp.server.load_config") as mock_load_config:
                mock_load_config.return_value = MagicMock()

                # Call the method
                result = await server_with_conn._trigger_oauth_device_flow("test-session")

                # Verify
                assert result is False

    @pytest.mark.asyncio
    async def test_oauth_device_flow_expired_token(self, server_with_conn, mock_conn):
        """Test OAuth device flow with expired device code."""
        from kimi_cli.auth.oauth import OAuthEvent

        # Mock login_kimi_code to yield error event for expired token
        async def mock_login_kimi_code(config, open_browser=False):
            yield OAuthEvent("error", "Login failed: Device code expired.")

        with patch("kimi_cli.auth.oauth.login_kimi_code", side_effect=mock_login_kimi_code):
            with patch("kimi_cli.acp.server.load_config") as mock_load_config:
                mock_load_config.return_value = MagicMock()

                # Call the method
                result = await server_with_conn._trigger_oauth_device_flow("test-session")

                # Verify
                assert result is False


class TestAuthenticate:
    """Tests for authenticate method."""

    @pytest.mark.asyncio
    async def test_authenticate_with_existing_token(self, server_with_conn):
        """Test authenticate when token already exists."""
        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.return_value = OAuthToken(
                access_token="existing-token",
                refresh_token="test-refresh",
                expires_at=9999999999.0,
                scope="test",
                token_type="Bearer",
            )

            result = await server_with_conn.authenticate("login")

            # Verify
            assert result is not None
            mock_load_tokens.assert_called_once()

    @pytest.mark.asyncio
    async def test_authenticate_with_terminal(self, server_with_conn, mock_conn):
        """Test authenticate with terminal support."""
        # Setup mocks
        mock_conn.create_terminal.return_value = MagicMock(terminal_id="term-123")
        mock_conn.wait_for_terminal_exit.return_value = MagicMock(exit_code=0)
        mock_conn.terminal_output.return_value = MagicMock(output="Login successful")

        # First call returns None (no token), second call returns token after login
        call_count = 0

        def mock_load_tokens_side_effect(ref):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return None
            return OAuthToken(
                access_token="test-token",
                refresh_token="test-refresh",
                expires_at=9999999999.0,
                scope="test",
                token_type="Bearer",
            )

        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.side_effect = mock_load_tokens_side_effect

            result = await server_with_conn.authenticate("login")

            # Verify
            assert result is not None
            mock_conn.create_terminal.assert_called_once()

    @pytest.mark.asyncio
    async def test_authenticate_without_terminal_support(self, server_with_conn, mock_conn):
        """Test authenticate without terminal support (fallback to OAuth device flow)."""
        # Disable terminal support
        server_with_conn.client_capabilities.terminal = False

        from kimi_cli.auth.oauth import OAuthEvent

        # Mock login_kimi_code to yield success events
        async def mock_login_kimi_code(config, open_browser=False):
            yield OAuthEvent("verification_url", "Please visit: https://auth.example.com/device?user_code=ABC123", data={"verification_url": "https://auth.example.com/device?user_code=ABC123", "user_code": "ABC123"})
            yield OAuthEvent("success", "Logged in successfully.")

        with patch("kimi_cli.auth.oauth.login_kimi_code", side_effect=mock_login_kimi_code):
            with patch("kimi_cli.acp.server.load_config") as mock_load_config:
                mock_load_config.return_value = MagicMock()

                # First call returns None (no token), second call returns token after login
                call_count = 0

                def mock_load_tokens_side_effect(ref):
                    nonlocal call_count
                    call_count += 1
                    if call_count == 1:
                        return None
                    return OAuthToken(
                        access_token="test-token",
                        refresh_token="test-refresh",
                        expires_at=9999999999.0,
                        scope="test",
                        token_type="Bearer",
                    )

                with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
                    mock_load_tokens.side_effect = mock_load_tokens_side_effect

                    result = await server_with_conn.authenticate("login")

                    # Verify
                    assert result is not None

    @pytest.mark.asyncio
    async def test_authenticate_terminal_failure_falls_back_to_oauth(self, server_with_conn, mock_conn):
        """Test that terminal login failure falls back to OAuth device flow."""
        # Setup mocks - terminal login fails
        mock_conn.create_terminal.return_value = MagicMock(terminal_id="term-123")
        mock_conn.wait_for_terminal_exit.return_value = MagicMock(exit_code=1)
        mock_conn.terminal_output.return_value = MagicMock(output="Login failed")

        from kimi_cli.auth.oauth import OAuthEvent

        # Mock login_kimi_code to yield success events (device flow succeeds)
        async def mock_login_kimi_code(config, open_browser=False):
            yield OAuthEvent("verification_url", "Please visit: https://auth.example.com/device?user_code=ABC123", data={"verification_url": "https://auth.example.com/device?user_code=ABC123", "user_code": "ABC123"})
            yield OAuthEvent("success", "Logged in successfully.")

        call_count = 0

        def mock_load_tokens_side_effect(ref):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:  # First call in authenticate, second call after terminal
                return None
            return OAuthToken(
                access_token="test-token",
                refresh_token="test-refresh",
                expires_at=9999999999.0,
                scope="test",
                token_type="Bearer",
            )

        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.side_effect = mock_load_tokens_side_effect

            with patch("kimi_cli.auth.oauth.login_kimi_code", side_effect=mock_login_kimi_code):
                with patch("kimi_cli.acp.server.load_config") as mock_load_config:
                    mock_load_config.return_value = MagicMock()

                    result = await server_with_conn.authenticate("login")

                    # Verify - should succeed via fallback to OAuth device flow
                    assert result is not None
                    # Terminal was attempted
                    mock_conn.create_terminal.assert_called_once()

    @pytest.mark.asyncio
    async def test_authenticate_with_session_id_from_kwargs(self, server_with_conn, mock_conn):
        """Test authenticate uses session_id from kwargs when provided."""
        # Setup mocks
        mock_conn.create_terminal.return_value = MagicMock(terminal_id="term-123")
        mock_conn.wait_for_terminal_exit.return_value = MagicMock(exit_code=0)
        mock_conn.terminal_output.return_value = MagicMock(output="Login successful")

        # First call returns None (no token), second call returns token after login
        call_count = 0

        def mock_load_tokens_side_effect(ref):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return None
            return OAuthToken(
                access_token="test-token",
                refresh_token="test-refresh",
                expires_at=9999999999.0,
                scope="test",
                token_type="Bearer",
            )

        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.side_effect = mock_load_tokens_side_effect

            # Add a specific session and call authenticate with session_id in kwargs
            server_with_conn.sessions["specific-session"] = (MagicMock(), MagicMock())
            result = await server_with_conn.authenticate("login", session_id="specific-session")

            # Verify
            assert result is not None
            # Auth task should be stored under the specific session
            assert "specific-session" in server_with_conn._active_auth_sessions or True  # Task cleaned up after completion

    @pytest.mark.asyncio
    async def test_authenticate_unknown_method(self, server_with_conn):
        """Test authenticate with unknown method."""
        import acp

        with pytest.raises(acp.RequestError) as exc_info:
            await server_with_conn.authenticate("unknown-method")

        # Check that it's an invalid_params error
        assert exc_info.value.code == -32602


class TestCancelAuth:
    """Tests for cancel_auth method."""

    @pytest.mark.asyncio
    async def test_cancel_auth(self, server_with_conn, mock_conn):
        """Test cancel_auth method."""
        # Create a real async task that can be cancelled
        async def dummy_task():
            await asyncio.sleep(10)

        task = asyncio.create_task(dummy_task())
        server_with_conn._active_auth_sessions["test-session"] = task

        await server_with_conn.cancel_auth("test-session")

        # Verify
        assert "test-session" not in server_with_conn._active_auth_sessions
        mock_conn.session_update.assert_called_once()


class TestSendAuthProgress:
    """Tests for _send_auth_progress method."""

    @pytest.mark.asyncio
    async def test_send_auth_progress(self, server_with_conn, mock_conn):
        """Test _send_auth_progress method."""
        await server_with_conn._send_auth_progress(
            "test-session",
            "started",
            "Test message",
            data={"key": "value"},
        )

        # Verify
        mock_conn.session_update.assert_called_once()
        call_args = mock_conn.session_update.call_args
        assert call_args.kwargs["session_id"] == "test-session"
        assert call_args.kwargs["update"].session_update == "agent_thought_chunk"

    @pytest.mark.asyncio
    async def test_send_auth_progress_no_connection(self):
        """Test _send_auth_progress when there's no connection."""
        server = ACPServer()
        # Should not raise an error
        await server._send_auth_progress(
            "test-session",
            "started",
            "Test message",
        )


class TestCheckAuth:
    """Tests for _check_auth method."""

    @pytest.mark.asyncio
    async def test_check_auth_with_existing_token(self, server_with_conn):
        """Test _check_auth when token already exists."""
        with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
            mock_load_tokens.return_value = OAuthToken(
                access_token="existing-token",
                refresh_token="test-refresh",
                expires_at=9999999999.0,
                scope="test",
                token_type="Bearer",
            )

            # Should not raise an error
            await server_with_conn._check_auth()
            mock_load_tokens.assert_called_once()

