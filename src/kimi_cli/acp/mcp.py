from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import acp.schema
from fastmcp.mcp_config import MCPConfig
from pydantic import ValidationError

from kimi_cli.acp.types import MCPServer
from kimi_cli.exception import MCPConfigError


@dataclass
class MCPServerDict:
    """Typed intermediate representation of an MCP server config."""

    transport: str
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)  # pyright: ignore[reportUnknownVariableType]
    command: str | None = None
    args: list[str] = field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    env: dict[str, str] = field(default_factory=dict)  # pyright: ignore[reportUnknownVariableType]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"transport": self.transport}
        if self.url is not None:
            result["url"] = self.url
        if self.headers:
            result["headers"] = self.headers
        if self.command is not None:
            result["command"] = self.command
        if self.args:
            result["args"] = self.args
        if self.env:
            result["env"] = self.env
        return result


def acp_mcp_servers_to_mcp_config(mcp_servers: list[MCPServer]) -> MCPConfig:
    if not mcp_servers:
        return MCPConfig()

    try:
        servers = {server.name: _convert_acp_mcp_server(server).to_dict() for server in mcp_servers}
        return MCPConfig.model_validate({"mcpServers": servers})
    except ValidationError as exc:
        raise MCPConfigError(f"Invalid MCP config from ACP client: {exc}") from exc


def _convert_acp_mcp_server(server: MCPServer) -> MCPServerDict:
    """Convert an ACP MCP server to a typed representation."""
    match server:
        case acp.schema.HttpMcpServer():
            return MCPServerDict(
                url=server.url,
                transport="http",
                headers={header.name: header.value for header in server.headers},
            )
        case acp.schema.SseMcpServer():
            return MCPServerDict(
                url=server.url,
                transport="sse",
                headers={header.name: header.value for header in server.headers},
            )
        case acp.schema.McpServerStdio():
            return MCPServerDict(
                command=server.command,
                args=server.args,
                env={item.name: item.value for item in server.env},
                transport="stdio",
            )
