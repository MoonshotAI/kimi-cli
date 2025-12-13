"""Test MCP session ID is set correctly."""

from __future__ import annotations

from unittest.mock import MagicMock


class TestMCPSessionId:
    """Test that mcp-session-id header is set for HTTP transports."""

    def test_set_mcp_session_id_for_underlying_transports(self):
        """_set_mcp_session_id should set header on _underlying_transports."""
        from kimi_cli.soul.agent import _set_mcp_session_id

        mock_inner_transport = MagicMock(spec=["headers"])
        mock_inner_transport.headers = {}

        mock_client = MagicMock()
        mock_client.transport = MagicMock()
        mock_client.transport._underlying_transports = [mock_inner_transport]

        session_id = "test-session-123"
        _set_mcp_session_id(mock_client, session_id)

        assert mock_inner_transport.headers["mcp-session-id"] == session_id

    def test_set_mcp_session_id_for_direct_transport(self):
        """_set_mcp_session_id should set header on direct transport with headers."""
        from kimi_cli.soul.agent import _set_mcp_session_id

        mock_transport = MagicMock(spec=["headers"])
        mock_transport.headers = {}

        mock_client = MagicMock()
        mock_client.transport = mock_transport

        session_id = "test-session-456"
        _set_mcp_session_id(mock_client, session_id)

        assert mock_transport.headers["mcp-session-id"] == session_id

    def test_set_mcp_session_id_skips_stdio_transport(self):
        """_set_mcp_session_id should not fail for stdio transport without headers."""
        from kimi_cli.soul.agent import _set_mcp_session_id

        mock_transport = MagicMock(spec=[])
        mock_client = MagicMock()
        mock_client.transport = mock_transport

        session_id = "test-session-789"
        # Should not raise - just silently skip
        _set_mcp_session_id(mock_client, session_id)
        # Verify no headers attribute was added
        assert not hasattr(mock_transport, "headers")
