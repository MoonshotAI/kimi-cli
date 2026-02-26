from __future__ import annotations

import json

from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text

from kimi_cli.feedback.models import Phase1Request
from kimi_cli.ui.shell.console import console


def _format_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def display_feedback_summary(
    phase1: Phase1Request,
    context_size: int = 0,
    wire_size: int = 0,
    log_size: int = 0,
    source_size: int = 0,
) -> None:
    """Display a summary of data that will be uploaded."""
    table = Table(show_header=False, border_style="dim", padding=(0, 1))
    table.add_column("Key", style="bold cyan", width=16)
    table.add_column("Value")

    # System
    si = phase1.system_info
    table.add_row("System", f"{si.os_name} {si.os_release} {si.os_arch}")
    table.add_row("Version", f"Kimi CLI {si.kimi_cli_version} / Python {si.python_version}")

    # Session
    if phase1.session_summary:
        ss = phase1.session_summary
        table.add_row("Session", f"{ss.title} ({ss.message_count} msgs, {ss.token_count} tokens)")
    else:
        table.add_row("Session", "[dim]None[/dim]")

    # Git
    if phase1.git_info and phase1.git_info.is_repo:
        gi = phase1.git_info
        dirty_str = " (dirty)" if gi.dirty else ""
        table.add_row("Git", f"{gi.branch or '?'}@{gi.commit or '?'}{dirty_str}")

    # MCP
    if phase1.mcp_servers:
        connected = sum(1 for s in phase1.mcp_servers if s.status == "connected")
        table.add_row("MCP Servers", f"{connected}/{len(phase1.mcp_servers)} connected")

    # Active model
    if phase1.active_model:
        am = phase1.active_model
        thinking_str = " +thinking" if am.thinking_enabled else ""
        table.add_row("Model", f"{am.model_name} ({am.provider_type}){thinking_str}")

    # Token usage
    if phase1.token_usage_summary:
        ts = phase1.token_usage_summary
        ctx_pct = f"{ts.context_usage_pct:.1%}" if ts.context_usage_pct else "0%"
        table.add_row(
            "Tokens",
            f"in:{ts.total_input_tokens:,} out:{ts.total_output_tokens:,} ctx:{ctx_pct}",
        )

    # Execution summary
    if phase1.execution_summary:
        es = phase1.execution_summary
        parts = [f"{es.total_turns} turns", f"{es.total_steps} steps"]
        if es.compaction_count > 0:
            parts.append(f"{es.compaction_count} compactions")
        if es.session_duration_seconds is not None:
            dur = es.session_duration_seconds
            if dur >= 60:
                parts.append(f"{dur / 60:.1f}min")
            else:
                parts.append(f"{dur:.0f}s")
        table.add_row("Execution", ", ".join(parts))

    # Tool summary
    if phase1.tool_summary and phase1.tool_summary.total_tool_calls > 0:
        tl = phase1.tool_summary
        tool_str = f"{tl.total_tool_calls} calls"
        if tl.tool_failures > 0:
            tool_str += f", {tl.tool_failures} failed"
        if tl.tool_rejections > 0:
            tool_str += f", {tl.tool_rejections} rejected"
        table.add_row("Tools", tool_str)

    # Errors
    n_exc = len(phase1.error_info.recent_exceptions)
    if n_exc > 0 or phase1.error_info.last_error:
        table.add_row("Errors", f"{n_exc} recent exception(s)")

    # User message
    if phase1.user_message:
        table.add_row("Message", phase1.user_message[:100])

    # Phase 2 sizes
    phase2_lines: list[str] = []
    if context_size > 0:
        phase2_lines.append(f"  context.jsonl    {_format_size(context_size)}")
    if wire_size > 0:
        phase2_lines.append(f"  wire_tail.jsonl  {_format_size(wire_size)}")
    if log_size > 0:
        phase2_lines.append(f"  kimi.log         {_format_size(log_size)}")
    if source_size > 0:
        phase2_lines.append(f"  source.zip       {_format_size(source_size)}")

    renderables: list[RenderableType] = [table]

    if phase2_lines:
        renderables.append(Text(""))
        renderables.append(Text("Phase 2 Attachments:", style="bold"))
        for line in phase2_lines:
            renderables.append(Text(line, style="dim"))

    console.print(
        Panel(
            Group(*renderables),
            title="Feedback Summary (sensitive data redacted)",
            border_style="cyan",
        )
    )


def display_feedback_detail(phase1: Phase1Request) -> None:
    """Display full redacted metadata in a pager."""
    data = phase1.model_dump(mode="json", exclude_none=True)
    json_str = json.dumps(data, ensure_ascii=False, indent=2)

    with console.pager(styles=True):
        console.print(
            Panel(
                Syntax(json_str, "json", theme="monokai", word_wrap=True),
                title="Feedback Detail (redacted)",
                border_style="cyan",
            )
        )
