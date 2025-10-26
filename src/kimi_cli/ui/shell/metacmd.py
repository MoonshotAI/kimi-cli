import asyncio
import tempfile
import webbrowser
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple, overload

from kosong.base.message import Message
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from rich.panel import Panel

import kimi_cli.prompts as prompts
from kimi_cli.soul.context import Context
from kimi_cli.soul.globals import load_agents_md
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.message import system
from kimi_cli.tools.review import (
    ReviewError,
    build_review_prompt,
    collect_commit_diff,
    collect_uncommitted_diff,
    get_recent_commits,
    is_git_repo,
)
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.changelog import CHANGELOG, format_release_notes
from kimi_cli.utils.logging import logger

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


@meta_command
async def review(app: "ShellApp", args: list[str]):
    """Run AI-powered code review for local changes"""

    repo_path = Path.cwd()
    if not is_git_repo(repo_path):
        console.print(
            "[red]Current directory is not a git repository. Review cannot proceed.[/red]"
        )
        return

    try:
        review_target = await ChoiceInput(
            message="Select review target",
            options=[
                ("uncommitted", "Review uncommitted changes"),
                ("commit", "Review a commit"),
            ],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt, asyncio.CancelledError):
        return

    if not review_target:
        console.print("[yellow]Code review cancelled.[/yellow]")
        return

    scope_hint: str | None = None
    if review_target == "uncommitted":
        console.print("[grey50]Collecting uncommitted changes…[/grey50]")
        try:
            diff_text = collect_uncommitted_diff(repo_path)
        except ReviewError as exc:
            console.print(f"[red]Failed to collect uncommitted changes: {exc}[/red]")
            return
        scope_hint = "Reviewing uncommitted workspace changes"
    else:
        commits = get_recent_commits(repo_path, limit=20)
        if not commits:
            console.print("[red]Unable to load recent commits.[/red]")
            return

        commit_lookup = {commit.sha: commit for commit in commits}
        options = [
            (commit.sha, f"{commit.short_sha} {_truncate_subject(commit.subject)}")
            for commit in commits
        ]
        options.append(("", "Cancel"))

        try:
            selected = await ChoiceInput(
                message="Select a commit to review",
                options=options,
            ).prompt_async()
        except (EOFError, KeyboardInterrupt, asyncio.CancelledError):
            return

        if not selected:
            console.print("[yellow]Commit review cancelled.[/yellow]")
            return

        if selected not in commit_lookup:
            console.print(
                "[red]Selected commit is not available. Please rerun the review command.[/red]"
            )
            return

        commit = commit_lookup[selected]

        scope_hint = f"Reviewing commit {commit.short_sha} — {_truncate_subject(commit.subject)}"
        console.print(f"[grey50]Collecting diff for commit {commit.short_sha}…[/grey50]")
        try:
            diff_text = collect_commit_diff(repo_path, commit.sha)
        except ReviewError as exc:
            console.print(f"[red]Failed to collect commit diff: {exc}[/red]")
            return

    prompt = build_review_prompt(diff_text, scope_hint=scope_hint)
    console.print("[grey50]Requesting review from the model…[/grey50]")

    try:
        ok = await app._run_soul_command(prompt)
    except asyncio.CancelledError:
        logger.info("Code review interrupted by user")
        console.print("[red]Code review interrupted by user.[/red]")
        return
    except Exception as exc:  # noqa: BLE001 -- surface unexpected failures to the user
        logger.exception("Code review execution failed")
        console.print(f"[red]Code review failed: {exc}[/red]")
        return
    if not ok:
        console.print(
            "[red]Code review did not complete successfully. Check the logs above for provider "
            "details.[/red]"
        )


def _truncate_subject(subject: str, *, limit: int = 60) -> str:
    if len(subject) <= limit:
        return subject
    return subject[: limit - 3] + "..."


@meta_command(kimi_soul_only=True)
async def init(app: "ShellApp", args: list[str]):
    """Analyze the codebase and generate an `AGENTS.md` file"""
    assert isinstance(app.soul, KimiSoul)

    soul_bak = app.soul
    with tempfile.TemporaryDirectory() as temp_dir:
        logger.info("Running `/init`")
        console.print("Analyzing the codebase...")
        tmp_context = Context(file_backend=Path(temp_dir) / "context.jsonl")
        app.soul = KimiSoul(
            soul_bak._agent,
            soul_bak._agent_globals,
            context=tmp_context,
            loop_control=soul_bak._loop_control,
        )
        ok = await app._run_soul_command(prompts.INIT)

        if ok:
            console.print(
                "Codebase analyzed successfully! "
                "An [underline]AGENTS.md[/underline] file has been created."
            )
        else:
            console.print("[red]Failed to analyze the codebase.[/red]")

    app.soul = soul_bak
    agents_md = load_agents_md(soul_bak._agent_globals.builtin_args.KIMI_WORK_DIR)
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


from . import (  # noqa: E402
    debug,  # noqa: F401
    setup,  # noqa: F401
    update,  # noqa: F401
)
