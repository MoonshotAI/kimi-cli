from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from prompt_toolkit.shortcuts.choice_input import ChoiceInput

from kimi_cli.cli import Reload
from kimi_cli.config import save_config
from kimi_cli.platforms import get_platform_name_for_provider, refresh_managed_models
from kimi_cli.session import Session
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.changelog import CHANGELOG
from kimi_cli.utils.datetime import format_relative_time
from kimi_cli.utils.slashcmd import SlashCommand, SlashCommandRegistry

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell

type ShellSlashCmdFunc = Callable[[Shell, str], None | Awaitable[None]]
"""
A function that runs as a Shell-level slash command.

Raises:
    Reload: When the configuration should be reloaded.
"""


registry = SlashCommandRegistry[ShellSlashCmdFunc]()
shell_mode_registry = SlashCommandRegistry[ShellSlashCmdFunc]()


def _ensure_kimi_soul(app: Shell) -> KimiSoul | None:
    if not isinstance(app.soul, KimiSoul):
        console.print("[red]KimiSoul required[/red]")
        return None
    return app.soul


@registry.command(aliases=["quit"])
@shell_mode_registry.command(aliases=["quit"])
def exit(app: Shell, args: str):
    """Exit the application"""
    # should be handled by `Shell`
    raise NotImplementedError


SKILL_COMMAND_PREFIX = "skill:"

_KEYBOARD_SHORTCUTS = [
    ("Ctrl-X", "Toggle agent/shell mode"),
    ("Tab", "Toggle thinking mode"),
    ("Ctrl-J / Alt-Enter", "Insert newline"),
    ("Ctrl-V", "Paste (supports images)"),
    ("Ctrl-D", "Exit"),
    ("Ctrl-C", "Interrupt"),
]


@registry.command(aliases=["h", "?"])
@shell_mode_registry.command(aliases=["h", "?"])
def help(app: Shell, args: str):
    """Show help information"""
    from io import StringIO

    from rich.console import Console as RichConsole
    from rich.console import Group, RenderableType
    from rich.text import Text

    from kimi_cli.utils.rich.columns import BulletColumns

    def section(title: str, items: list[tuple[str, str]], color: str) -> BulletColumns:
        lines: list[RenderableType] = [Text.from_markup(f"[bold]{title}:[/bold]")]
        for name, desc in items:
            lines.append(
                BulletColumns(
                    Text.from_markup(f"[{color}]{name}[/{color}]: [grey50]{desc}[/grey50]"),
                    bullet_style=color,
                )
            )
        return BulletColumns(Group(*lines))

    buffer = StringIO()
    buf = RichConsole(file=buffer, force_terminal=True, width=console.width)

    buf.print(
        BulletColumns(
            Group(
                Text.from_markup("[grey50]Help! I need somebody. Help! Not just anybody.[/grey50]"),
                Text.from_markup("[grey50]Help! You know I need someone. Help![/grey50]"),
                Text.from_markup("[grey50]\u2015 The Beatles, [italic]Help![/italic][/grey50]"),
            ),
            bullet_style="grey50",
        )
    )
    buf.print(
        BulletColumns(
            Text(
                "Sure, Kimi CLI is ready to help! "
                "Just send me messages and I will help you get things done!"
            ),
        )
    )

    commands: list[SlashCommand[Any]] = []
    skills: list[SlashCommand[Any]] = []
    for cmd in app.available_slash_commands.values():
        if cmd.name.startswith(SKILL_COMMAND_PREFIX):
            skills.append(cmd)
        else:
            commands.append(cmd)

    buf.print(
        section(
            "Slash commands",
            [(c.slash_name(), c.description) for c in sorted(commands, key=lambda c: c.name)],
            "blue",
        )
    )
    if skills:
        buf.print(
            section(
                "Skills",
                [(c.slash_name(), c.description) for c in sorted(skills, key=lambda c: c.name)],
                "cyan",
            )
        )
    buf.print(section("Keyboard shortcuts", _KEYBOARD_SHORTCUTS, "yellow"))

    with console.pager(styles=True):
        console.print(buffer.getvalue(), end="")


@registry.command
@shell_mode_registry.command
def version(app: Shell, args: str):
    """Show version information"""
    from kimi_cli.constant import VERSION

    console.print(f"kimi, version {VERSION}")


@registry.command
async def model(app: Shell, args: str):
    """List or switch LLM models"""
    import shlex

    soul = _ensure_kimi_soul(app)
    if soul is None:
        return
    config = soul.runtime.config

    await refresh_managed_models(config)

    if not config.models:
        console.print('[yellow]No models configured, send "/setup" to configure.[/yellow]')
        return

    current_model = soul.runtime.llm.model_config if soul.runtime.llm else None
    current_model_name: str | None = None
    if current_model is not None:
        for name, model in config.models.items():
            if model == current_model:
                current_model_name = name
                break
        assert current_model_name is not None

    raw_args = args.strip()
    if not raw_args:
        choices: list[tuple[str, str]] = []
        for name in sorted(config.models):
            model = config.models[name]
            provider_label = get_platform_name_for_provider(model.provider) or model.provider
            marker = " (current)" if name == current_model_name else ""
            label = f"{model.model} ({provider_label}){marker}"
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


@registry.command(aliases=["release-notes"])
@shell_mode_registry.command(aliases=["release-notes"])
def changelog(app: Shell, args: str):
    """Show release notes"""
    from io import StringIO

    from rich.console import Console as RichConsole
    from rich.console import Group, RenderableType
    from rich.text import Text

    from kimi_cli.utils.rich.columns import BulletColumns

    buffer = StringIO()
    buf_console = RichConsole(file=buffer, force_terminal=True, width=console.width)

    for ver, entry in CHANGELOG.items():
        title = f"[bold]{ver}[/bold]"
        if entry.description:
            title += f": {entry.description}"

        lines: list[RenderableType] = [Text.from_markup(title)]
        for item in entry.entries:
            if item.lower().startswith("lib:"):
                continue
            lines.append(
                BulletColumns(
                    Text.from_markup(f"[grey50]{item}[/grey50]"),
                    bullet_style="grey50",
                ),
            )
        buf_console.print(BulletColumns(Group(*lines)))

    with console.pager(styles=True):
        console.print(buffer.getvalue(), end="")


@registry.command
@shell_mode_registry.command
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
    if soul is None:
        return
    await soul.context.clear()
    raise Reload()


@registry.command(name="sessions", aliases=["resume"])
async def list_sessions(app: Shell, args: str):
    """List sessions and resume optionally"""
    soul = _ensure_kimi_soul(app)
    if soul is None:
        return

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
    from rich.console import Group, RenderableType
    from rich.text import Text

    from kimi_cli.soul.toolset import KimiToolset
    from kimi_cli.utils.rich.columns import BulletColumns

    soul = _ensure_kimi_soul(app)
    if soul is None:
        return
    toolset = soul.agent.toolset
    if not isinstance(toolset, KimiToolset):
        console.print("[red]KimiToolset required[/red]")
        return

    servers = toolset.mcp_servers

    if not servers:
        console.print("[yellow]No MCP servers configured.[/yellow]")
        return

    n_conn = sum(1 for s in servers.values() if s.status == "connected")
    n_tools = sum(len(s.tools) for s in servers.values())
    console.print(
        BulletColumns(
            Text.from_markup(
                f"[bold]MCP Servers:[/bold] {n_conn}/{len(servers)} connected, {n_tools} tools"
            )
        )
    )

    status_colors = {
        "connected": "green",
        "connecting": "cyan",
        "pending": "yellow",
        "failed": "red",
        "unauthorized": "red",
    }
    for name, info in servers.items():
        color = status_colors.get(info.status, "red")
        server_text = f"[{color}]{name}[/{color}]"
        if info.status == "unauthorized":
            server_text += " [grey50](unauthorized - run: kimi mcp auth {name})[/grey50]"
        elif info.status != "connected":
            server_text += f" [grey50]({info.status})[/grey50]"

        lines: list[RenderableType] = [Text.from_markup(server_text)]
        for tool in info.tools:
            lines.append(
                BulletColumns(
                    Text.from_markup(f"[grey50]{tool.name}[/grey50]"),
                    bullet_style="grey50",
                )
            )
        console.print(BulletColumns(Group(*lines), bullet_style=color))


from . import (  # noqa: E402
    debug,  # noqa: F401 # type: ignore[reportUnusedImport]
    setup,  # noqa: F401 # type: ignore[reportUnusedImport]
    update,  # noqa: F401 # type: ignore[reportUnusedImport]
    usage,  # noqa: F401 # type: ignore[reportUnusedImport]
)
