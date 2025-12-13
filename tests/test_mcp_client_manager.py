"""Tests for MCPClientManager - MCP connection lifecycle management."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kimi_cli.soul.agent import MCPClientManager


@pytest.mark.asyncio
async def test_connect_creates_clients_and_keeps_them_connected():
    """Test that connect() creates clients and keeps them in connected state."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("fastmcp.Client", return_value=mock_client):
        manager = MCPClientManager()
        configs = [{"url": "http://test1.com"}, {"url": "http://test2.com"}]

        clients = await manager.connect(configs)

        assert len(clients) == 2
        assert mock_client.__aenter__.call_count == 2


@pytest.mark.asyncio
async def test_close_disconnects_all_clients():
    """Test that close() properly disconnects all clients."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("fastmcp.Client", return_value=mock_client):
        manager = MCPClientManager()
        await manager.connect([{"url": "http://test.com"}])

        await manager.close()

        assert mock_client.__aexit__.call_count == 1


@pytest.mark.asyncio
async def test_connect_with_empty_configs():
    """Test that connect() with empty configs returns empty list."""
    manager = MCPClientManager()
    clients = await manager.connect([])

    assert clients == []


@pytest.mark.asyncio
async def test_close_without_connect_is_safe():
    """Test that close() without prior connect() doesn't raise."""
    manager = MCPClientManager()
    await manager.close()


@pytest.mark.asyncio
async def test_clients_remain_connected_between_tool_calls():
    """Test that clients stay connected for multiple tool calls."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.call_tool = AsyncMock(return_value=MagicMock(content=[], is_error=False))

    with patch("fastmcp.Client", return_value=mock_client):
        manager = MCPClientManager()
        clients = await manager.connect([{"url": "http://test.com"}])

        # Simulate multiple tool calls
        await clients[0].call_tool("tool1", {})
        await clients[0].call_tool("tool2", {})
        await clients[0].call_tool("tool3", {})

        # Client should still be connected (only entered once)
        assert mock_client.__aenter__.call_count == 1
        assert mock_client.__aexit__.call_count == 0

        # Now close
        await manager.close()
        assert mock_client.__aexit__.call_count == 1


@pytest.mark.asyncio
async def test_connect_cleans_up_on_failure():
    """Test that connect() cleans up already-connected clients if one fails."""
    call_count = 0

    async def mock_aenter(self):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            raise RuntimeError("Connection failed")
        return self

    mock_client = AsyncMock()
    mock_client.__aenter__ = mock_aenter
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("fastmcp.Client", return_value=mock_client):
        manager = MCPClientManager()
        configs = [{"url": "http://test1.com"}, {"url": "http://test2.com"}]

        with pytest.raises(RuntimeError, match="Connection failed"):
            await manager.connect(configs)

        # First client should have been cleaned up
        assert mock_client.__aexit__.call_count == 1
        assert manager._clients == []
        assert manager._exit_stack is None
