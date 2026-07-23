from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

from fastmcp.mcp_config import MCPConfig, StdioMCPServer

from kimi_cli.soul.toolset import KimiToolset

_STRICT_MCP_SERVER = r"""
import json
import pathlib
import sys

counter_path = pathlib.Path(sys.argv[1])
initialize_count = 0

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    if method == "initialize":
        initialize_count += 1
        counter_path.write_text(str(initialize_count), encoding="utf-8")
        if initialize_count > 1:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32600, "message": "Server is already initialized"},
            }
        else:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": request["params"]["protocolVersion"],
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "strict-test-server", "version": "1.0"},
                },
            }
    elif method == "tools/list":
        response = {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [{
                    "name": "echo",
                    "description": "Echo text",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"],
                    },
                }],
            },
        }
    elif method == "tools/call":
        response = {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": request["params"]["arguments"]["text"]}],
                "isError": False,
            },
        }
    else:
        continue
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
"""


async def test_stdio_mcp_client_reuses_its_initialized_session(tmp_path: Path) -> None:
    server = tmp_path / "strict_mcp_server.py"
    server.write_text(_STRICT_MCP_SERVER, encoding="utf-8")
    initialize_counter = tmp_path / "initialize-count.txt"
    config = MCPConfig(
        mcpServers={
            "strict": StdioMCPServer(
                command=sys.executable,
                args=[str(server), str(initialize_counter)],
            )
        }
    )

    runtime = MagicMock()
    runtime.config.mcp.client.tool_call_timeout_ms = 5_000
    runtime.approval.request = AsyncMock(return_value=MagicMock())
    toolset = KimiToolset()

    try:
        await toolset.load_mcp_tools([config], runtime, in_background=False)
        tool = toolset.find("echo")
        assert tool is not None

        first = await cast(Any, tool)(text="first")
        second = await cast(Any, tool)(text="second")

        assert first.is_error is False
        assert second.is_error is False
        assert initialize_counter.read_text(encoding="utf-8") == "1"
    finally:
        await toolset.cleanup()
