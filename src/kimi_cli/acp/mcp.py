from __future__ import annotations

from typing import Any

import acp.schema
from fastmcp.mcp_config import MCPConfig
from pydantic import ValidationError

from kimi_cli.acp.types import MCPServer
from kimi_cli.exception import MCPConfigError


def acp_mcp_servers_to_mcp_config(mcp_servers: list[MCPServer]) -> MCPConfig:
    if not mcp_servers:
        return MCPConfig()

    try:
        return MCPConfig.model_validate(
            {"mcpServers": {server.name: _convert_acp_mcp_server(server) for server in mcp_servers}}
        )
    except ValidationError as exc:
        raise MCPConfigError(f"Invalid MCP config from ACP client: {exc}") from exc


def _convert_acp_mcp_server(server: MCPServer) -> dict[str, Any]:
    """Convert an ACP MCP server to a dictionary representation."""
    from kimi_cli.constant import USER_AGENT

    match server:
        case acp.schema.HttpMcpServer():
            headers = {header.name: header.value for header in server.headers}
            headers.setdefault("User-Agent", USER_AGENT)
            return {
                "url": server.url,
                "transport": "http",
                "headers": headers,
            }
        case acp.schema.SseMcpServer():
            headers = {header.name: header.value for header in server.headers}
            headers.setdefault("User-Agent", USER_AGENT)
            return {
                "url": server.url,
                "transport": "sse",
                "headers": headers,
            }
        case acp.schema.McpServerStdio():
            return {
                "command": server.command,
                "args": server.args,
                "env": {item.name: item.value for item in server.env},
                "transport": "stdio",
            }
