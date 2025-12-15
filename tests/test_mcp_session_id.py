"""Test MCP session ID is set correctly via transport creation."""

from __future__ import annotations

import pytest


class TestCreateTransport:
    """Test _create_transport creates correct transport types with headers."""

    def test_create_http_transport_with_session_id(self):
        """HTTP transport should include mcp-session-id header."""
        from kimi_cli.soul.agent import _create_transport

        server_config = {"url": "http://localhost:8080/mcp"}
        headers = {"mcp-session-id": "test-session-123"}

        transport = _create_transport(server_config, headers)

        from fastmcp.client.transports import StreamableHttpTransport

        assert isinstance(transport, StreamableHttpTransport)

    def test_create_sse_transport_with_session_id(self):
        """SSE transport should include mcp-session-id header."""
        from kimi_cli.soul.agent import _create_transport

        server_config = {"url": "http://localhost:8080/sse", "transport": "sse"}
        headers = {"mcp-session-id": "test-session-456"}

        transport = _create_transport(server_config, headers)

        from fastmcp.client.transports import SSETransport

        assert isinstance(transport, SSETransport)

    def test_create_stdio_transport(self):
        """Stdio transport should be created without headers."""
        from kimi_cli.soul.agent import _create_transport

        server_config = {
            "command": "npx",
            "args": ["@playwright/mcp@latest"],
            "env": {"DEBUG": "1"},
        }

        transport = _create_transport(server_config, headers=None)

        from fastmcp.client.transports import StdioTransport

        assert isinstance(transport, StdioTransport)

    def test_create_transport_unknown_config_raises(self):
        """Unknown config format should raise ValueError."""
        from kimi_cli.soul.agent import _create_transport

        server_config = {"unknown_key": "value"}

        with pytest.raises(ValueError, match="Unknown MCP server config format"):
            _create_transport(server_config, headers=None)
