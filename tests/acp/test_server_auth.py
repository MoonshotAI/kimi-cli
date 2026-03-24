"""Tests for ACP server authentication enhancements."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import acp
import pytest

from kimi_cli.acp.server import ACPServer
from kimi_cli.auth.oauth import DeviceAuthorization, OAuthToken


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
        # Mock request_device_authorization
        mock_auth = DeviceAuthorization(
            user_code="ABC123",
            device_code="device-abc",
            verification_uri="https://auth.example.com/device",
            verification_uri_complete="https://auth.example.com/device?user_code=ABC123",
            expires_in=600,
            interval=5,
        )

        with patch("kimi_cli.acp.server.request_device_authorization") as mock_request:
            mock_request.return_value = mock_auth

            # Mock _request_device_token to return success after a few calls
            call_count = 0

            async def mock_request_device_token(auth):
                nonlocal call_count
                call_count += 1
                if call_count <= 2:
                    # Return pending status
                    return 400, {"error": "authorization_pending"}
                # Return success with access token
                return 200, {
                    "access_token": "test-token",
                    "refresh_token": "test-refresh",
                    "expires_in": 3600,
                    "scope": "test",
                    "token_type": "Bearer",
                }

            with patch("kimi_cli.acp.server._request_device_token", side_effect=mock_request_device_token):
                with patch("kimi_cli.acp.server.save_tokens") as mock_save:
                    # Mock asyncio.sleep to speed up the test
                    with patch("kimi_cli.acp.server.asyncio.sleep") as mock_sleep:
                        mock_sleep.return_value = None

                        # Call the method
                        result = await server_with_conn._trigger_oauth_device_flow("test-session")

                        # Verify
                        assert result is True
                        mock_request.assert_called_once()
                        mock_save.assert_called_once()

    @pytest.mark.asyncio
    async def test_oauth_device_flow_timeout(self, server_with_conn, mock_conn):
        """Test OAuth device flow timeout."""
        # Mock request_device_authorization
        mock_auth = DeviceAuthorization(
            user_code="ABC123",
            device_code="device-abc",
            verification_uri="https://auth.example.com/device",
            verification_uri_complete="https://auth.example.com/device?user_code=ABC123",
            expires_in=600,
            interval=1,
        )

        with patch("kimi_cli.acp.server.request_device_authorization") as mock_request:
            mock_request.return_value = mock_auth

            # Mock _request_device_token to always return pending
            async def mock_request_device_token(auth):
                return 400, {"error": "authorization_pending"}

            with patch("kimi_cli.acp.server._request_device_token", side_effect=mock_request_device_token):
                # Mock asyncio.sleep to speed up the test
                with patch("kimi_cli.acp.server.asyncio.sleep") as mock_sleep:
                    mock_sleep.return_value = None

                    # Call the method
                    result = await server_with_conn._trigger_oauth_device_flow("test-session")

                    # Verify
                    assert result is False
                    mock_request.assert_called_once()

    @pytest.mark.asyncio
    async def test_oauth_device_flow_expired_token(self, server_with_conn, mock_conn):
        """Test OAuth device flow with expired device code."""
        # Mock request_device_authorization
        mock_auth = DeviceAuthorization(
            user_code="ABC123",
            device_code="device-abc",
            verification_uri="https://auth.example.com/device",
            verification_uri_complete="https://auth.example.com/device?user_code=ABC123",
            expires_in=600,
            interval=1,
        )

        with patch("kimi_cli.acp.server.request_device_authorization") as mock_request:
            mock_request.return_value = mock_auth

            # Mock _request_device_token to return expired token error
            async def mock_request_device_token(auth):
                return 400, {"error": "expired_token"}

            with patch("kimi_cli.acp.server._request_device_token", side_effect=mock_request_device_token):
                # Mock asyncio.sleep to speed up the test
                with patch("kimi_cli.acp.server.asyncio.sleep") as mock_sleep:
                    mock_sleep.return_value = None

                    # Call the method
                    result = await server_with_conn._trigger_oauth_device_flow("test-session")

                    # Verify
                    assert result is False
                    mock_request.assert_called_once()


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

        # Mock request_device_authorization
        mock_auth = DeviceAuthorization(
            user_code="ABC123",
            device_code="device-abc",
            verification_uri="https://auth.example.com/device",
            verification_uri_complete="https://auth.example.com/device?user_code=ABC123",
            expires_in=600,
            interval=5,
        )

        with patch("kimi_cli.acp.server.request_device_authorization") as mock_request:
            mock_request.return_value = mock_auth

            # Mock _request_device_token to return success immediately
            async def mock_request_device_token(auth):
                return 200, {
                    "access_token": "test-token",
                    "refresh_token": "test-refresh",
                    "expires_in": 3600,
                    "scope": "test",
                    "token_type": "Bearer",
                }

            with patch("kimi_cli.acp.server._request_device_token", side_effect=mock_request_device_token):
                with patch("kimi_cli.acp.server.save_tokens") as mock_save:
                    # Mock asyncio.sleep to speed up the test
                    with patch("kimi_cli.acp.server.asyncio.sleep") as mock_sleep:
                        mock_sleep.return_value = None

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
                            mock_request.assert_called_once()
                            mock_save.assert_called_once()

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

        # Mock SessionUpdate
        mock_update = MagicMock()
        mock_update.session_update = "auth_progress"
        
        with patch("kimi_cli.acp.server.acp.schema") as mock_schema:
            mock_schema.SessionUpdate = MagicMock(return_value=mock_update)
            await server_with_conn.cancel_auth("test-session")

            # Verify
            assert "test-session" not in server_with_conn._active_auth_sessions
            mock_conn.session_update.assert_called_once()


class TestSendAuthProgress:
    """Tests for _send_auth_progress method."""

    @pytest.mark.asyncio
    async def test_send_auth_progress(self, server_with_conn, mock_conn):
        """Test _send_auth_progress method."""
        # Mock SessionUpdate
        mock_update = MagicMock()
        mock_update.session_update = "auth_progress"
        
        with patch("kimi_cli.acp.server.acp.schema") as mock_schema:
            mock_schema.SessionUpdate = MagicMock(return_value=mock_update)
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
            assert call_args.kwargs["update"].session_update == "auth_progress"

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

    @pytest.mark.asyncio
    async def test_check_auth_auto_authentication_success(self, server_with_conn, mock_conn):
        """Test _check_auth auto-triggers OAuth device flow and succeeds."""
        # Mock request_device_authorization
        mock_auth = DeviceAuthorization(
            user_code="ABC123",
            device_code="device-abc",
            verification_uri="https://auth.example.com/device",
            verification_uri_complete="https://auth.example.com/device?user_code=ABC123",
            expires_in=600,
            interval=1,
        )

        with patch("kimi_cli.acp.server.request_device_authorization") as mock_request:
            mock_request.return_value = mock_auth

            # Mock _request_device_token to return success immediately
            async def mock_request_device_token(auth):
                return 200, {
                    "access_token": "test-token",
                    "refresh_token": "test-refresh",
                    "expires_in": 3600,
                    "scope": "test",
                    "token_type": "Bearer",
                }

            with patch("kimi_cli.acp.server._request_device_token", side_effect=mock_request_device_token):
                with patch("kimi_cli.acp.server.save_tokens") as mock_save:
                    # Mock asyncio.sleep to speed up the test
                    with patch("kimi_cli.acp.server.asyncio.sleep") as mock_sleep:
                        mock_sleep.return_value = None

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

                            # Should not raise an error (auto-authentication successful)
                            await server_with_conn._check_auth()

                            # Verify
                            mock_request.assert_called_once()
                            mock_save.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_auth_auto_authentication_failure(self, server_with_conn, mock_conn):
        """Test _check_auth auto-triggers OAuth device flow but fails."""
        # Mock request_device_authorization
        mock_auth = DeviceAuthorization(
            user_code="ABC123",
            device_code="device-abc",
            verification_uri="https://auth.example.com/device",
            verification_uri_complete="https://auth.example.com/device?user_code=ABC123",
            expires_in=600,
            interval=1,
        )

        with patch("kimi_cli.acp.server.request_device_authorization") as mock_request:
            mock_request.return_value = mock_auth

            # Mock _request_device_token to always return pending (timeout)
            async def mock_request_device_token(auth):
                return 400, {"error": "authorization_pending"}

            with patch("kimi_cli.acp.server._request_device_token", side_effect=mock_request_device_token):
                # Mock asyncio.sleep to speed up the test
                with patch("kimi_cli.acp.server.asyncio.sleep") as mock_sleep:
                    mock_sleep.return_value = None

                    # Mock load_tokens to always return None
                    with patch("kimi_cli.acp.server.load_tokens") as mock_load_tokens:
                        mock_load_tokens.return_value = None

                        # Should raise AUTH_REQUIRED error after auto-authentication fails
                        with pytest.raises(acp.RequestError) as exc_info:
                            await server_with_conn._check_auth()

                        # Check that it's an auth_required error
                        assert exc_info.value.code == -32000
                        mock_request.assert_called_once()
