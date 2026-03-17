from __future__ import annotations

from types import SimpleNamespace

from rich.console import Console

from kimi_cli.soul.toolset import KimiToolset, MCPServerInfo
from kimi_cli.ui.shell.mcp_status import (
    get_mcp_status_snapshot,
    render_mcp_console,
    render_mcp_prompt,
)


def test_render_mcp_servers_shows_live_loading_summary() -> None:
    toolset = KimiToolset()
    toolset._mcp_servers = {
        "context7": MCPServerInfo(
            status="connecting",
            client=SimpleNamespace(),
            tools=[SimpleNamespace(name="resolve-library-id")],
        ),
        "chrome-devtools": MCPServerInfo(
            status="pending",
            client=SimpleNamespace(),
            tools=[],
        ),
    }
    toolset._mcp_loading_task = SimpleNamespace(done=lambda: False)

    snapshot = get_mcp_status_snapshot(toolset)
    assert snapshot is not None

    console = Console(record=True, force_terminal=False, width=120)
    console.print(render_mcp_console(snapshot))
    output = console.export_text()

    assert "MCP Servers: 0/2 connected, 1 tools" in output
    assert "context7 (connecting)" in output
    assert "chrome-devtools (pending)" in output

    prompt_text = "".join(text for _, text in render_mcp_prompt(snapshot, now=0.0))
    assert "MCP Servers: 0/2 connected, 1 tools" in prompt_text
    assert "context7 (connecting, 1 tool)" in prompt_text
    assert "chrome-devtools (pending)" in prompt_text
    assert "resolve-library-id" not in prompt_text


def test_render_mcp_servers_shows_final_statuses() -> None:
    toolset = KimiToolset()
    toolset._mcp_servers = {
        "context7": MCPServerInfo(
            status="connected",
            client=SimpleNamespace(),
            tools=[
                SimpleNamespace(name="resolve-library-id"),
                SimpleNamespace(name="query-docs"),
            ],
        ),
        "chrome-devtools": MCPServerInfo(
            status="failed",
            client=SimpleNamespace(),
            tools=[],
        ),
    }

    snapshot = get_mcp_status_snapshot(toolset)
    assert snapshot is not None

    console = Console(record=True, force_terminal=False, width=120)
    console.print(render_mcp_console(snapshot))
    output = console.export_text()

    assert "MCP Servers: 1/2 connected, 2 tools" in output
    assert "context7" in output
    assert "resolve-library-id" in output
    assert "query-docs" in output
    assert "chrome-devtools (failed)" in output

    prompt_text = "".join(text for _, text in render_mcp_prompt(snapshot, now=0.0))
    assert "MCP Servers: 1/2 connected, 2 tools" in prompt_text
    assert "context7 (2 tools)" in prompt_text
    assert "chrome-devtools (failed)" in prompt_text
    assert "resolve-library-id" not in prompt_text
    assert "query-docs" not in prompt_text
