from __future__ import annotations

from rich.console import Console

from kimi_cli.ui.shell.mcp_status import (
    render_mcp_console,
    render_mcp_prompt,
)
from kimi_cli.wire.types import MCPServerSnapshot, MCPStatusSnapshot


def test_render_mcp_servers_shows_live_loading_summary() -> None:
    snapshot = MCPStatusSnapshot(
        loading=True,
        connected=0,
        total=2,
        tools=1,
        servers=(
            MCPServerSnapshot(
                name="context7",
                status="connecting",
                tools=("resolve-library-id",),
            ),
            MCPServerSnapshot(
                name="chrome-devtools",
                status="pending",
                tools=(),
            ),
        ),
    )

    console = Console(record=True, force_terminal=False, width=120)
    console.print(render_mcp_console(snapshot))
    output = console.export_text()

    assert "MCP Servers: 0/2 connected, 1 tools" in output
    assert "context7 (connecting)" in output
    assert "chrome-devtools (pending)" in output

    prompt_text = "".join(fragment[1] for fragment in render_mcp_prompt(snapshot, now=0.0))
    assert "MCP Servers: 0/2 connected, 1 tools" in prompt_text
    assert "context7 (connecting, 1 tool)" in prompt_text
    assert "chrome-devtools (pending)" in prompt_text
    assert "resolve-library-id" not in prompt_text


def test_render_mcp_servers_shows_final_statuses() -> None:
    snapshot = MCPStatusSnapshot(
        loading=False,
        connected=1,
        total=2,
        tools=2,
        servers=(
            MCPServerSnapshot(
                name="context7",
                status="connected",
                tools=("resolve-library-id", "query-docs"),
            ),
            MCPServerSnapshot(
                name="chrome-devtools",
                status="failed",
                tools=(),
            ),
        ),
    )

    console = Console(record=True, force_terminal=False, width=120)
    console.print(render_mcp_console(snapshot))
    output = console.export_text()

    assert "MCP Servers: 1/2 connected, 2 tools" in output
    assert "context7" in output
    assert "resolve-library-id" in output
    assert "query-docs" in output
    assert "chrome-devtools (failed)" in output

    prompt_text = "".join(fragment[1] for fragment in render_mcp_prompt(snapshot, now=0.0))
    assert prompt_text == ""
