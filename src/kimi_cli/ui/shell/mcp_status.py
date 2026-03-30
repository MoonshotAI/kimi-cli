from __future__ import annotations

import time

from prompt_toolkit.formatted_text import FormattedText
from rich.console import Group, RenderableType
from rich.spinner import Spinner
from rich.text import Text

from kimi_cli.ui.shell.theme import get_theme_colors
from kimi_cli.utils.rich.columns import BulletColumns
from kimi_cli.wire.types import MCPServerSnapshot, MCPStatusSnapshot

_SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")


def render_mcp_console(snapshot: MCPStatusSnapshot) -> RenderableType:
    header_text = Text.assemble(
        ("MCP Servers: ", "bold"),
        f"{snapshot.connected}/{snapshot.total} connected, {snapshot.tools} tools",
    )
    header: RenderableType = Spinner("dots", header_text) if snapshot.loading else header_text

    renderables: list[RenderableType] = [BulletColumns(header)]
    for server in snapshot.servers:
        color = _status_color(server.status)
        server_text = f"[{color}]{server.name}[/{color}]"
        if server.status == "unauthorized":
            server_text += f" [dim](unauthorized - run: kimi mcp auth {server.name})[/dim]"
        elif server.status != "connected":
            server_text += f" [dim]({server.status})[/dim]"

        lines: list[RenderableType] = [Text.from_markup(server_text)]
        for tool_name in server.tools:
            lines.append(
                BulletColumns(
                    Text.from_markup(f"[dim]{tool_name}[/dim]"),
                    bullet_style="dim",
                )
            )
        renderables.append(BulletColumns(Group(*lines), bullet_style=color))

    return Group(*renderables)


def render_mcp_prompt(snapshot: MCPStatusSnapshot, *, now: float | None = None) -> FormattedText:
    if not snapshot.loading:
        return FormattedText([])

    colors = get_theme_colors()
    fragments: list[tuple[str, str]] = []
    prefix = f"{_spinner_frame(now)} " if snapshot.loading else ""
    fragments.append(
        (
            f"fg:{colors.toolbar_text}",
            (
                f"{prefix}MCP Servers: "
                f"{snapshot.connected}/{snapshot.total} connected, {snapshot.tools} tools"
            ),
        )
    )
    fragments.append(("", "\n"))

    for server in snapshot.servers:
        fragments.append((_prompt_status_style(server.status), f"• {server.name}"))
        detail = _prompt_server_detail(server)
        if detail:
            fragments.append((f"fg:{colors.prompt_placeholder}", detail))
        fragments.append(("", "\n"))

    return FormattedText(fragments)


def _spinner_frame(now: float | None = None) -> str:
    timestamp = time.monotonic() if now is None else now
    return _SPINNER_FRAMES[int(timestamp * 8) % len(_SPINNER_FRAMES)]


def _status_color(status: str) -> str:
    return {
        "connected": "green",
        "connecting": "cyan",
        "pending": "yellow",
        "failed": "red",
        "unauthorized": "red",
    }.get(status, "red")


def _prompt_status_style(status: str) -> str:
    return {
        "connected": "fg:#56d364",
        "connecting": "fg:#56a4ff",
        "pending": "fg:#f2cc60",
        "failed": "fg:#ff7b72",
        "unauthorized": "fg:#ff7b72",
    }.get(status, "fg:#ff7b72")


def _prompt_server_detail(server: MCPServerSnapshot) -> str:
    if server.status == "unauthorized":
        return f" (unauthorized - run: kimi mcp auth {server.name})"

    parts: list[str] = []
    if server.status != "connected":
        parts.append(server.status)
    if server.tools:
        label = "tool" if len(server.tools) == 1 else "tools"
        parts.append(f"{len(server.tools)} {label}")

    return f" ({', '.join(parts)})" if parts else ""
