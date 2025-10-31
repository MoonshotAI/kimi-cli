import getpass
import tempfile
import webbrowser
from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple, overload

from kosong.base.message import Message
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from rich.panel import Panel

import kimi_cli.prompts as prompts
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.message import system
from kimi_cli.soul.runtime import load_agents_md
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.liveview import _LeftAlignedMarkdown
from kimi_cli.utils.changelog import CHANGELOG, format_release_notes
from kimi_cli.utils.logging import logger
from kimi_cli.utils.message import message_extract_text

if TYPE_CHECKING:
    from kimi_cli.ui.shell import ShellApp

type MetaCmdFunc = Callable[["ShellApp", list[str]], None | Awaitable[None]]
"""
A function that runs as a meta command.

Raises:
    LLMNotSet: When the LLM is not set.
    ChatProviderError: When the LLM provider returns an error.
    Reload: When the configuration should be reloaded.
    asyncio.CancelledError: When the command is interrupted by user.

This is quite similar to the `Soul.run` method.
"""


class MetaCommand(NamedTuple):
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
def exit(app: "ShellApp", args: list[str]):
    """Exit the application"""
    # should be handled by `ShellApp`
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
def help(app: "ShellApp", args: list[str]):
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
def version(app: "ShellApp", args: list[str]):
    """Show version information"""
    from kimi_cli.constant import VERSION

    console.print(f"kimi, version {VERSION}")


@meta_command(name="release-notes")
def release_notes(app: "ShellApp", args: list[str]):
    """Show release notes"""
    text = format_release_notes(CHANGELOG)
    with console.pager(styles=True):
        console.print(Panel.fit(text, border_style="wheat4", title="Release Notes"))


@meta_command
def feedback(app: "ShellApp", args: list[str]):
    """Submit feedback to make Kimi CLI better"""

    ISSUE_URL = "https://github.com/MoonshotAI/kimi-cli/issues"
    if webbrowser.open(ISSUE_URL):
        return
    console.print(f"Please submit feedback at [underline]{ISSUE_URL}[/underline].")


@meta_command(kimi_soul_only=True)
async def init(app: "ShellApp", args: list[str]):
    """Analyze the codebase and generate an `AGENTS.md` file"""
    assert isinstance(app.soul, KimiSoul)

    soul_bak = app.soul
    with tempfile.TemporaryDirectory() as temp_dir:
        logger.info("Running `/init`")
        console.print("Analyzing the codebase...")
        tmp_context = Context(file_backend=Path(temp_dir) / "context.jsonl")
        app.soul = KimiSoul(soul_bak._agent, soul_bak._runtime, context=tmp_context)
        ok = await app._run_soul_command(prompts.INIT)

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
async def clear(app: "ShellApp", args: list[str]):
    """Clear the context"""
    assert isinstance(app.soul, KimiSoul)

    if app.soul._context.n_checkpoints == 0:
        console.print("[yellow]Context is empty.[/yellow]")
        return

    await app.soul._context.revert_to(0)
    console.print("[green]✓[/green] Context has been cleared.")


@meta_command(kimi_soul_only=True)
async def compact(app: "ShellApp", args: list[str]):
    """Compact the context"""
    assert isinstance(app.soul, KimiSoul)

    if app.soul._context.n_checkpoints == 0:
        console.print("[yellow]Context is empty.[/yellow]")
        return

    logger.info("Running `/compact`")
    with console.status("[cyan]Compacting...[/cyan]"):
        await app.soul.compact_context()
    console.print("[green]✓[/green] Context has been compacted.")


@meta_command(aliases=["resume"], kimi_soul_only=True)
async def session(app: "ShellApp", args: list[str]):
    """List all conversation sessions and switch to a previous one to continue"""
    from kimi_cli.metadata import list_sessions

    assert isinstance(app.soul, KimiSoul)
    work_dir = app.soul._runtime.builtin_args.KIMI_WORK_DIR

    session_list = list_sessions(work_dir)

    if not session_list:
        console.print("[yellow]No sessions found.[/yellow]")
        return

    # Build a list of choices for the user to select from
    choices = []
    session_map = {}  # Map display string to session_id
    preview_width = 50  # Fix the width of the preview column

    for _i, (session_id, _path, info) in enumerate(session_list, start=1):
        # Build a relative time calculation
        now = datetime.now()
        time_diff = now - info["timestamp"]
        if time_diff < timedelta(minutes=5):
            time_str = "just now"
        elif time_diff < timedelta(hours=1):
            minutes = int(time_diff.total_seconds() / 60)
            time_str = f"{minutes}m ago"
        elif time_diff < timedelta(days=1):
            hours = int(time_diff.total_seconds() / 3600)
            time_str = f"{hours}h ago"
        elif time_diff < timedelta(days=7):
            days = time_diff.days
            time_str = f"{days}d ago"
        else:
            time_str = info["timestamp"].strftime("%m-%d")

        preview = info["first_message"] or "empty"
        if len(preview) > preview_width - 3:
            preview_display = preview[: preview_width - 3] + "..."
        else:
            preview_display = preview.ljust(preview_width)

        marker = "→" if info["is_current"] else " "
        label = f"{marker} {preview_display}  {time_str} · {info['num_messages']} msgs"
        choices.append((label, label))
        session_map[label] = (session_id, info)

    try:
        result = await ChoiceInput(
            message="Select a session to switch to(↑↓ navigate, Enter select, Ctrl+C cancel):",
            options=choices,
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    if result is None:
        return

    # Get session_id and info from the selected label
    if result not in session_map:
        console.print("[red]Invalid selection.[/red]")
        return

    session_id, session_info = session_map[result]

    if session_info["is_current"]:
        console.print("[yellow]You are already in this session.[/yellow]")
        return

    from kimi_cli.metadata import load_session
    from kimi_cli.soul.context import Context

    new_session = load_session(work_dir, session_id)
    if not new_session:
        console.print("[red]Failed to load session.[/red]")
        return

    new_context = Context(file_backend=new_session.history_file)
    restored = await new_context.restore()

    if not restored or not new_context.history:
        console.print("[yellow]The session is empty.[/yellow]")
        return

    # Switch to the new session completely
    app.soul._context = new_context

    # Update runtime to point to the new session
    new_runtime = app.soul._runtime._replace(session=new_session)
    app.soul._runtime = new_runtime

    console.clear()
    _render_history(list(new_context.history))

    # Confirm successful switch
    console.print("[green]✓ Session switched successfully[/green]")
    console.print()


def _render_history(history: list[Message]):
    """Render the history as a table to display"""
    username = getpass.getuser()

    for msg in history:
        if msg.role == "user":
            text = message_extract_text(msg)

            # dmail will add some system messages, skip them
            if text and not (text.startswith("<system>") and text.endswith("</system>")):
                console.print(f"[bold]{username}✨[/bold] {text}")
                console.print()

        elif msg.role == "assistant":
            text = message_extract_text(msg)
            if text:
                md = _LeftAlignedMarkdown(text, justify="left")
                console.print(md)
                console.print()


from . import (  # noqa: E402
    debug,  # noqa: F401
    setup,  # noqa: F401
    update,  # noqa: F401
)
