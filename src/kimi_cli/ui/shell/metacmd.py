import tempfile
import webbrowser
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple, overload

from kosong.base.message import Message
from rich.panel import Panel

import kimi_cli.prompts as prompts
from kimi_cli.cli import Reload
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.message import system
from kimi_cli.soul.runtime import load_agents_md
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
    text = format_release_notes(CHANGELOG, include_lib_changes=False)
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
async def usage(app: "ShellApp", args: list[str]):
    """Display API usage information and remaining quota"""
    import aiohttp
    from rich.table import Table

    from kimi_cli.config import load_config
    from kimi_cli.utils.aiohttp import new_client_session

    # Load configuration
    config = load_config()

    # Check if a model is configured
    if not config.default_model or not config.models:
        console.print("[red]No model configured. Please run /setup first.[/red]")
        return

    # Get the default model and provider
    model = config.models[config.default_model]
    provider = config.providers[model.provider]

    if not provider.base_url or not provider.api_key:
        console.print("[red]API configuration incomplete. Please run /setup first.[/red]")
        return

    # Try to fetch usage information from the API
    usage_url = f"{provider.base_url}/usage"

    try:
        async with (
            new_client_session() as session,
            session.get(
                usage_url,
                headers={
                    "Authorization": f"Bearer {provider.api_key.get_secret_value()}",
                },
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response,
        ):
            if response.status == 404:
                # Try alternative endpoint
                usage_url = f"{provider.base_url}/account/usage"
                async with session.get(
                    usage_url,
                    headers={
                        "Authorization": f"Bearer {provider.api_key.get_secret_value()}",
                    },
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as alt_response:
                    if alt_response.status == 404:
                        console.print(
                            "[yellow]Usage endpoint not available for this API provider.[/yellow]"
                        )
                        return
                    alt_response.raise_for_status()
                    usage_data = await alt_response.json()
            else:
                response.raise_for_status()
                usage_data = await response.json()

    except aiohttp.ClientResponseError as e:
        if e.status == 401:
            console.print("[red]Authentication failed. Please check your API key.[/red]")
        elif e.status == 403:
            console.print(
                "[red]Access forbidden. You may not have permission to view usage data.[/red]"
            )
        else:
            console.print(f"[red]API error ({e.status}): {e.message}[/red]")
        return
    except aiohttp.ClientError as e:
        console.print(f"[red]Network error: {e}[/red]")
        return
    except Exception as e:
        logger.exception("Failed to fetch usage information:")
        console.print(f"[red]Failed to fetch usage information: {e}[/red]")
        return

    # Display usage information
    table = Table(title="API Usage Information", show_header=True, header_style="bold cyan")
    table.add_column("Metric", style="cyan", no_wrap=True)
    table.add_column("Value", style="white")

    # Parse and display usage data based on common API response formats
    if "data" in usage_data:
        usage_data = usage_data["data"]

    # Display available fields
    if "total_usage" in usage_data or "usage" in usage_data:
        usage = usage_data.get("total_usage") or usage_data.get("usage", 0)
        table.add_row("Current Usage", f"{usage:,}")

    if "total_quota" in usage_data or "quota" in usage_data:
        quota = usage_data.get("total_quota") or usage_data.get("quota", 0)
        table.add_row("Total Quota", f"{quota:,}")

        # Calculate remaining and percentage if we have both usage and quota
        if "total_usage" in usage_data or "usage" in usage_data:
            usage = usage_data.get("total_usage") or usage_data.get("usage", 0)
            remaining = quota - usage
            percentage = (usage / quota * 100) if quota > 0 else 0

            table.add_row("Remaining", f"{remaining:,}")
            table.add_row("Usage Percentage", f"{percentage:.2f}%")

    if "reset_date" in usage_data or "reset_time" in usage_data:
        reset = usage_data.get("reset_date") or usage_data.get("reset_time")
        table.add_row("Reset Date", str(reset))

    # If no standard fields found, display raw data
    if table.row_count == 0:
        for key, value in usage_data.items():
            if not key.startswith("_"):
                table.add_row(key.replace("_", " ").title(), str(value))

    console.print(table)


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
async def clear(app: "ShellApp", args: list[str]):
    """Clear the context"""
    assert isinstance(app.soul, KimiSoul)

    if app.soul._context.n_checkpoints == 0:
        raise Reload()

    await app.soul._context.revert_to(0)
    raise Reload()


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
