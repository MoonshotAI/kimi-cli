# pyright: standard

from __future__ import annotations

import tempfile
import webbrowser
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, overload

from kosong.message import Message
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from rich.panel import Panel

import kimi_cli.prompts as prompts
from kimi_cli.cli import Reload
from kimi_cli.session import Session
from kimi_cli.soul.agent import load_agents_md
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.message import system
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.changelog import CHANGELOG, format_release_notes
from kimi_cli.utils.datetime import format_relative_time
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell

type MetaCmdFunc = Callable[[Shell, list[str]], None | Awaitable[None]]
"""
A function that runs as a meta command.

Raises:
    LLMNotSet: When the LLM is not set.
    ChatProviderError: When the LLM provider returns an error.
    Reload: When the configuration should be reloaded.
    asyncio.CancelledError: When the command is interrupted by user.

This is quite similar to the `Soul.run` method.
"""


@dataclass(frozen=True, slots=True, kw_only=True)
class MetaCommand:
    name: str
    description: str
    func: MetaCmdFunc
    aliases: list[str]
    kimi_soul_only: bool
    # TODO: actually kimi_soul_only meta commands should be defined in KimiSoul

    def slash_name(self):
        """/name (aliases)"""
        if self.aliases:
            return f"/{self.name} ({', '.join(self.aliases)})"
        return f"/{self.name}"


# primary name -> MetaCommand
_meta_commands: dict[str, MetaCommand] = {}
# primary name or alias -> MetaCommand
_meta_command_aliases: dict[str, MetaCommand] = {}


def get_meta_command(name: str) -> MetaCommand | None:
    return _meta_command_aliases.get(name)


def get_meta_commands() -> list[MetaCommand]:
    """Get all unique primary meta commands (without duplicating aliases)."""
    return list(_meta_commands.values())


@overload
def meta_command(func: MetaCmdFunc, /) -> MetaCmdFunc: ...


@overload
def meta_command(
    *,
    name: str | None = None,
    aliases: Sequence[str] | None = None,
    kimi_soul_only: bool = False,
) -> Callable[[MetaCmdFunc], MetaCmdFunc]: ...


def meta_command(
    func: MetaCmdFunc | None = None,
    *,
    name: str | None = None,
    aliases: Sequence[str] | None = None,
    kimi_soul_only: bool = False,
) -> (
    MetaCmdFunc
    | Callable[
        [MetaCmdFunc],
        MetaCmdFunc,
    ]
):
    """Decorator to register a meta command with optional custom name and aliases.

    Usage examples:
      @meta_command
      def help(app: App, args: list[str]): ...

      @meta_command(name="run")
      def start(app: App, args: list[str]): ...

      @meta_command(aliases=["h", "?", "assist"])
      def help(app: App, args: list[str]): ...
    """

    def _register(f: MetaCmdFunc):
        primary = name or f.__name__
        alias_list = list(aliases) if aliases else []

        # Create the primary command with aliases
        cmd = MetaCommand(
            name=primary,
            description=(f.__doc__ or "").strip(),
            func=f,
            aliases=alias_list,
            kimi_soul_only=kimi_soul_only,
        )

        # Register primary command
        _meta_commands[primary] = cmd
        _meta_command_aliases[primary] = cmd

        # Register aliases pointing to the same command
        for alias in alias_list:
            _meta_command_aliases[alias] = cmd

        return f

    if func is not None:
        return _register(func)
    return _register


@meta_command(aliases=["quit"])
def exit(app: Shell, args: list[str]):
    """Exit the application"""
    # should be handled by `Shell`
    raise NotImplementedError


_HELP_MESSAGE_FMT = """
[grey50]▌ Help! I need somebody. Help! Not just anybody.[/grey50]
[grey50]▌ Help! You know I need someone. Help![/grey50]
[grey50]▌ ― The Beatles, [italic]Help![/italic][/grey50]

Sure, Kimi CLI is ready to help!
Just send me messages and I will help you get things done!

Meta commands are also available:

[grey50]{meta_commands_md}[/grey50]
"""


@meta_command(aliases=["h", "?"])
def help(app: Shell, args: list[str]):
    """Show help information"""
    console.print(
        Panel(
            _HELP_MESSAGE_FMT.format(
                meta_commands_md="\n".join(
                    f" • {command.slash_name()}: {command.description}"
                    for command in get_meta_commands()
                )
            ).strip(),
            title="Kimi CLI Help",
            border_style="wheat4",
            expand=False,
            padding=(1, 2),
        )
    )


@meta_command
def version(app: Shell, args: list[str]):
    """Show version information"""
    from kimi_cli.constant import VERSION

    console.print(f"kimi, version {VERSION}")


@meta_command(name="release-notes")
def release_notes(app: Shell, args: list[str]):
    """Show release notes"""
    text = format_release_notes(CHANGELOG, include_lib_changes=False)
    with console.pager(styles=True):
        console.print(Panel.fit(text, border_style="wheat4", title="Release Notes"))


@meta_command
def feedback(app: Shell, args: list[str]):
    """Submit feedback to make Kimi CLI better"""

    ISSUE_URL = "https://github.com/MoonshotAI/kimi-cli/issues"
    if webbrowser.open(ISSUE_URL):
        return
    console.print(f"Please submit feedback at [underline]{ISSUE_URL}[/underline].")


@meta_command(kimi_soul_only=True)
async def init(app: Shell, args: list[str]):
    """Analyze the codebase and generate an `AGENTS.md` file"""
    assert isinstance(app.soul, KimiSoul)

    soul_bak = app.soul
    with tempfile.TemporaryDirectory() as temp_dir:
        logger.info("Running `/init`")
        console.print("Analyzing the codebase...")
        tmp_context = Context(file_backend=Path(temp_dir) / "context.jsonl")
        app.soul = KimiSoul(soul_bak._agent, context=tmp_context)
        ok = await app._run_soul_command(prompts.INIT, thinking=False)

        if ok:
            console.print(
                "Codebase analyzed successfully! "
                "An [underline]AGENTS.md[/underline] file has been created."
            )
        else:
            console.print("[red]Failed to analyze the codebase.[/red]")

    app.soul = soul_bak
    agents_md = load_agents_md(soul_bak._runtime.builtin_args.KIMI_WORK_DIR)
    system_message = system(
        "The user just ran `/init` meta command. "
        "The system has analyzed the codebase and generated an `AGENTS.md` file. "
        f"Latest AGENTS.md file content:\n{agents_md}"
    )
    await app.soul._context.append_message(Message(role="user", content=[system_message]))


@meta_command(aliases=["reset"], kimi_soul_only=True)
async def clear(app: Shell, args: list[str]):
    """Clear the context"""
    assert isinstance(app.soul, KimiSoul)

    if app.soul._context.n_checkpoints == 0:
        raise Reload()

    await app.soul._context.clear()
    raise Reload()


@meta_command(kimi_soul_only=True)
async def compact(app: Shell, args: list[str]):
    """Compact the context"""
    assert isinstance(app.soul, KimiSoul)

    if app.soul._context.n_checkpoints == 0:
        console.print("[yellow]Context is empty.[/yellow]")
        return

    logger.info("Running `/compact`")
    with console.status("[cyan]Compacting...[/cyan]"):
        await app.soul.compact_context()
    console.print("[green]✓[/green] Context has been compacted.")


@meta_command(name="sessions", aliases=["resume"], kimi_soul_only=True)
async def list_sessions(app: Shell, args: list[str]):
    """List sessions and resume optionally"""
    assert isinstance(app.soul, KimiSoul)

    work_dir = app.soul._runtime.session.work_dir
    current_session = app.soul._runtime.session
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


@meta_command(kimi_soul_only=True)
async def yolo(app: Shell, args: list[str]):
    """Enable YOLO mode (auto approve all actions)"""
    assert isinstance(app.soul, KimiSoul)

    app.soul._runtime.approval.set_yolo(True)
    console.print("[green]✓[/green] Life is short, use YOLO!")


from . import (  # noqa: E402
    debug,  # noqa: F401
    setup,  # noqa: F401
    update,  # noqa: F401
)
