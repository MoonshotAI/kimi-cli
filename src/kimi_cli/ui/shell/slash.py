from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, cast

from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from rich.panel import Panel

from kimi_cli.cli import Reload
from kimi_cli.config import save_config
from kimi_cli.session import Session
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.changelog import CHANGELOG, format_release_notes
from kimi_cli.utils.datetime import format_relative_time
from kimi_cli.utils.slashcmd import SlashCommandRegistry

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell

type ShellSlashCmdFunc = Callable[[Shell, str], None | Awaitable[None]]
"""
A function that runs as a Shell-level slash command.

Raises:
    Reload: When the configuration should be reloaded.
"""


registry = SlashCommandRegistry[ShellSlashCmdFunc]()


def _ensure_kimi_soul(app: Shell) -> KimiSoul:
    if not isinstance(app.soul, KimiSoul):
        console.print("[red]KimiSoul required[/red]")
    return cast(KimiSoul, app.soul)


@registry.command(aliases=["quit"])
def exit(app: Shell, args: str):
    """Exit the application"""
    # should be handled by `Shell`
    raise NotImplementedError


_HELP_MESSAGE_FMT = """
[grey50]▌ Help! I need somebody. Help! Not just anybody.[/grey50]
[grey50]▌ Help! You know I need someone. Help![/grey50]
[grey50]▌ ― The Beatles, [italic]Help![/italic][/grey50]

Sure, Kimi CLI is ready to help!
Just send me messages and I will help you get things done!

Slash commands are also available:

[grey50]{slash_commands_md}[/grey50]
"""


@registry.command(aliases=["h", "?"])
def help(app: Shell, args: str):
    """Show help information"""
    console.print(
        Panel(
            _HELP_MESSAGE_FMT.format(
                slash_commands_md="\n".join(
                    f" • {command.slash_name()}: {command.description}"
                    for command in app.available_slash_commands.values()
                )
            ).strip(),
            title="Kimi CLI Help",
            border_style="wheat4",
            expand=False,
            padding=(1, 2),
        )
    )


@registry.command
def version(app: Shell, args: str):
    """Show version information"""
    from kimi_cli.constant import VERSION

    console.print(f"kimi, version {VERSION}")


@registry.command
async def model(app: Shell, args: str):
    """List or switch LLM models"""
    import shlex

    soul = _ensure_kimi_soul(app)
    config = soul.runtime.config

    if not config.models:
        console.print('[yellow]No models configured, send "/setup" to configure.[/yellow]')
        return

    current_model = soul.runtime.llm.model_config if soul.runtime.llm else None
    current_model_name: str | None = None
    for name, model in config.models.items():
        if model is current_model:
            current_model_name = name
            break

    raw_args = args.strip()
    if not raw_args:
        choices: list[tuple[str, str]] = []
        for name in sorted(config.models):
            model = config.models[name]
            marker = " (current)" if name == current_model_name else ""
            label = f"{name} ({model.provider}){marker}"
            choices.append((name, label))

        try:
            selection = await ChoiceInput(
                message=("Select a model to switch to (↑↓ navigate, Enter select, Ctrl+C cancel):"),
                options=choices,
                default=current_model_name or choices[0][0],
            ).prompt_async()
        except (EOFError, KeyboardInterrupt):
            return

        if not selection:
            return

        model_name = selection
    else:
        try:
            parsed_args = shlex.split(raw_args)
        except ValueError:
            console.print("[red]Usage: /model <name>[/red]")
            return
        if len(parsed_args) != 1:
            console.print("[red]Usage: /model <name>[/red]")
            return
        model_name = parsed_args[0]
    if model_name not in config.models:
        console.print(f"[red]Unknown model: {model_name}[/red]")
        return

    if current_model_name == model_name:
        console.print(f"[yellow]Already using model {model_name}.[/yellow]")
        return

    model = config.models[model_name]
    provider = config.providers.get(model.provider)
    if provider is None:
        console.print(f"[red]Provider not found for model: {model.provider}[/red]")
        return

    if not config.is_from_default_location:
        console.print(
            "[yellow]Model switching requires the default config file; "
            "restart without --config/--config-file.[/yellow]"
        )
        return

    previous_model = config.default_model
    config.default_model = model_name
    try:
        save_config(config)
    except OSError as exc:
        config.default_model = previous_model
        console.print(f"[red]Failed to save default config: {exc}[/red]")
        return

    console.print(f"[green]Switched to model {model_name}. Reloading...[/green]")
    raise Reload()


@registry.command(name="release-notes")
def release_notes(app: Shell, args: str):
    """Show release notes"""
    text = format_release_notes(CHANGELOG, include_lib_changes=False)
    with console.pager(styles=True):
        console.print(Panel.fit(text, border_style="wheat4", title="Release Notes"))


@registry.command
def feedback(app: Shell, args: str):
    """Submit feedback to make Kimi CLI better"""
    import webbrowser

    ISSUE_URL = "https://github.com/MoonshotAI/kimi-cli/issues"
    if webbrowser.open(ISSUE_URL):
        return
    console.print(f"Please submit feedback at [underline]{ISSUE_URL}[/underline].")


@registry.command(aliases=["reset"])
async def clear(app: Shell, args: str):
    """Clear the context"""
    soul = _ensure_kimi_soul(app)
    await soul.context.clear()
    raise Reload()


@registry.command(name="sessions", aliases=["resume"])
async def list_sessions(app: Shell, args: str):
    """List sessions and resume optionally"""
    soul = _ensure_kimi_soul(app)

    work_dir = soul.runtime.session.work_dir
    current_session = soul.runtime.session
    current_session_id = current_session.id
    sessions = [
        session for session in await Session.list(work_dir) if session.id != current_session_id
    ]

    await current_session.refresh()
    sessions.insert(0, current_session)

    choices: list[tuple[str, str]] = []
    for session in sessions:
        time_str = format_relative_time(session.updated_at)
        marker = " (current)" if session.id == current_session_id else ""
        label = f"{session.title}, {time_str}{marker}"
        choices.append((session.id, label))

    try:
        selection = await ChoiceInput(
            message="Select a session to switch to (↑↓ navigate, Enter select, Ctrl+C cancel):",
            options=choices,
            default=choices[0][0],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    if not selection:
        return

    if selection == current_session_id:
        console.print("[yellow]You are already in this session.[/yellow]")
        return

    console.print(f"[green]Switching to session {selection}...[/green]")
    raise Reload(session_id=selection)


@registry.command
async def mcp(app: Shell, args: str):
    """Show MCP servers and tools"""
    from kimi_cli.soul.toolset import KimiToolset

    soul = _ensure_kimi_soul(app)
    toolset = soul.agent.toolset
    if not isinstance(toolset, KimiToolset):
        console.print("[red]KimiToolset required[/red]")
        return

    servers = toolset.mcp_servers

    if not servers:
        console.print("[yellow]No MCP servers configured.[/yellow]")
        return

    lines: list[str] = []

    n_conn = sum(1 for s in servers.values() if s.status == "connected")
    n_tools = sum(len(s.tools) for s in servers.values())
    lines.append(f"{n_conn}/{len(servers)} servers connected, {n_tools} tools loaded")
    lines.append("")

    status_dots = {
        "connected": "[green]•[/green]",
        "connecting": "[cyan]•[/cyan]",
        "pending": "[yellow]•[/yellow]",
        "failed": "[red]•[/red]",
        "unauthorized": "[red]•[/red]",
    }
    for name, info in servers.items():
        dot = status_dots.get(info.status, "[red]•[/red]")
        server_line = f" {dot} {name}"
        if info.status == "unauthorized":
            server_line += f" (unauthorized - run: kimi mcp auth {name})"
        elif info.status != "connected":
            server_line += f" ({info.status})"
        lines.append(server_line)
        for tool in info.tools:
            lines.append(f"   [dim]• {tool.name}[/dim]")

    console.print(
        Panel(
            "\n".join(lines),
            title="MCP Servers",
            border_style="wheat4",
            expand=False,
            padding=(1, 2),
        )
    )


from . import (  # noqa: E402
    debug,  # noqa: F401 # type: ignore[reportUnusedImport]
    setup,  # noqa: F401 # type: ignore[reportUnusedImport]
    update,  # noqa: F401 # type: ignore[reportUnusedImport]
    usage,  # noqa: F401 # type: ignore[reportUnusedImport]
)
