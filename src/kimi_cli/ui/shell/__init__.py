from __future__ import annotations

import asyncio
import shlex
from collections.abc import Awaitable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import Any

from kosong.chat_provider import APIStatusError, ChatProviderError
from loguru import logger
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.prompt import CustomPromptSession, PromptMode, toast
from kimi_cli.ui.shell.replay import replay_recent_history
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.ui.shell.slash import shell_mode_registry
from kimi_cli.ui.shell.update import LATEST_VERSION_FILE, UpdateResult, do_update, semver_tuple
from kimi_cli.ui.shell.visualize import visualize
from kimi_cli.utils.envvar import get_env_bool
from kimi_cli.utils.signals import install_sigint_handler
from kimi_cli.utils.slashcmd import SlashCommand, SlashCommandCall, parse_slash_command_call
from kimi_cli.utils.term import ensure_new_line, ensure_tty_sane
from kimi_cli.wire.types import ContentPart, StatusUpdate


class Shell:
    def __init__(self, soul: Soul, welcome_info: list[WelcomeInfoItem] | None = None):
        self.soul = soul
        self._welcome_info = list(welcome_info or [])
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._available_slash_commands: dict[str, SlashCommand[Any]] = {
            **{cmd.name: cmd for cmd in soul.available_slash_commands},
            **{cmd.name: cmd for cmd in shell_slash_registry.list_commands()},
        }
        """Shell-level slash commands + soul-level slash commands. Name to command mapping."""

    @property
    def available_slash_commands(self) -> dict[str, SlashCommand[Any]]:
        """Get all available slash commands, including shell-level and soul-level commands."""
        return self._available_slash_commands

    async def run(self, command: str | None = None) -> bool:
        if command is not None:
            # run single command and exit
            logger.info("Running agent with command: {command}", command=command)
            return await self.run_soul_command(command)

        # Start auto-update background task if not disabled
        if get_env_bool("KIMI_CLI_NO_AUTO_UPDATE"):
            logger.info("Auto-update disabled by KIMI_CLI_NO_AUTO_UPDATE environment variable")
        else:
            self._start_background_task(self._auto_update())

        _print_welcome_info(self.soul.name or "Kimi CLI", self._welcome_info)

        if isinstance(self.soul, KimiSoul):
            await replay_recent_history(
                self.soul.context.history,
                wire_file=self.soul.wire_file,
            )

        with CustomPromptSession(
            status_provider=lambda: self.soul.status,
            model_capabilities=self.soul.model_capabilities or set(),
            model_name=self.soul.model_name,
            thinking=self.soul.thinking or False,
            agent_mode_slash_commands=list(self._available_slash_commands.values()),
            shell_mode_slash_commands=shell_mode_registry.list_commands(),
        ) as prompt_session:
            try:
                while True:
                    ensure_tty_sane()
                    try:
                        ensure_new_line()
                        user_input = await prompt_session.prompt()
                    except KeyboardInterrupt:
                        logger.debug("Exiting by KeyboardInterrupt")
                        console.print("[grey50]Tip: press Ctrl-D or send 'exit' to quit[/grey50]")
                        continue
                    except EOFError:
                        logger.debug("Exiting by EOF")
                        console.print("Bye!")
                        break

                    if not user_input:
                        logger.debug("Got empty input, skipping")
                        continue
                    logger.debug("Got user input: {user_input}", user_input=user_input)

                    if user_input.command in ["exit", "quit", "/exit", "/quit"]:
                        logger.debug("Exiting by slash command")
                        console.print("Bye!")
                        break

                    if user_input.mode == PromptMode.SHELL:
                        await self._run_shell_command(user_input.command)
                        continue

                    if slash_cmd_call := parse_slash_command_call(user_input.command):
                        await self._run_slash_command(slash_cmd_call)
                        continue

                    await self.run_soul_command(user_input.content)
            finally:
                ensure_tty_sane()

        return True

    async def _run_shell_command(self, command: str) -> None:
        """Run a shell command in foreground."""
        if not command.strip():
            return

        # Check if it's an allowed slash command in shell mode
        if slash_cmd_call := parse_slash_command_call(command):
            if shell_mode_registry.find_command(slash_cmd_call.name):
                await self._run_slash_command(slash_cmd_call)
                return
            else:
                console.print(
                    f'[yellow]"/{slash_cmd_call.name}" is not available in shell mode. '
                    "Press Ctrl-X to switch to agent mode.[/yellow]"
                )
                return

        # Check if user is trying to use 'cd' command
        stripped_cmd = command.strip()
        split_cmd = shlex.split(stripped_cmd)
        if len(split_cmd) == 2 and split_cmd[0] == "cd":
            console.print(
                "[yellow]Warning: Directory changes are not preserved across command executions."
                "[/yellow]"
            )
            return

        logger.info("Running shell command: {cmd}", cmd=command)

        proc: asyncio.subprocess.Process | None = None

        def _handler():
            logger.debug("SIGINT received.")
            if proc:
                proc.terminate()

        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, _handler)
        try:
            # TODO: For the sake of simplicity, we now use `create_subprocess_shell`.
            # Later we should consider making this behave like a real shell.
            proc = await asyncio.create_subprocess_shell(command)
            await proc.wait()
        except Exception as e:
            logger.exception("Failed to run shell command:")
            console.print(f"[red]Failed to run shell command: {e}[/red]")
        finally:
            remove_sigint()

    async def _run_slash_command(self, command_call: SlashCommandCall) -> None:
        from kimi_cli.cli import Reload

        if command_call.name not in self._available_slash_commands:
            logger.info("Unknown slash command /{command}", command=command_call.name)
            console.print(
                f'[red]Unknown slash command "/{command_call.name}", '
                'type "/" for all available commands[/red]'
            )
            return

        command = shell_slash_registry.find_command(command_call.name)
        if command is None:
            # the input is a soul-level slash command call
            await self.run_soul_command(command_call.raw_input)
            return

        logger.debug(
            "Running shell-level slash command: /{command} with args: {args}",
            command=command_call.name,
            args=command_call.args,
        )

        try:
            ret = command.func(self, command_call.args)
            if isinstance(ret, Awaitable):
                await ret
        except Reload:
            # just propagate
            raise
        except (asyncio.CancelledError, KeyboardInterrupt):
            # Handle Ctrl-C during slash command execution, return to shell prompt
            logger.debug("Slash command interrupted by KeyboardInterrupt")
            console.print("[red]Interrupted by user[/red]")
        except Exception as e:
            logger.exception("Unknown error:")
            console.print(f"[red]Unknown error: {e}[/red]")
            raise  # re-raise unknown error

    async def run_soul_command(self, user_input: str | list[ContentPart]) -> bool:
        """
        Run the soul and handle any known exceptions.

        Returns:
            bool: Whether the run is successful.
        """
        logger.info("Running soul with user input: {user_input}", user_input=user_input)

        cancel_event = asyncio.Event()

        def _handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, _handler)

        try:
            await run_soul(
                self.soul,
                user_input,
                lambda wire: visualize(
                    wire.ui_side(merge=False),  # shell UI maintain its own merge buffer
                    initial_status=StatusUpdate(context_usage=self.soul.status.context_usage),
                    cancel_event=cancel_event,
                ),
                cancel_event,
                self.soul.wire_file if isinstance(self.soul, KimiSoul) else None,
            )
            return True
        except LLMNotSet:
            logger.exception("LLM not set:")
            console.print('[red]LLM not set, send "/setup" to configure[/red]')
        except LLMNotSupported as e:
            # actually unsupported input/mode should already be blocked by prompt session
            logger.exception("LLM not supported:")
            console.print(f"[red]{e}[/red]")
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            if isinstance(e, APIStatusError) and e.status_code == 401:
                console.print("[red]Authorization failed, please check your API key[/red]")
            elif isinstance(e, APIStatusError) and e.status_code == 402:
                console.print("[red]Membership expired, please renew your plan[/red]")
            elif isinstance(e, APIStatusError) and e.status_code == 403:
                console.print("[red]Quota exceeded, please upgrade your plan or retry later[/red]")
            else:
                console.print(f"[red]LLM provider error: {e}[/red]")
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            console.print(f"[yellow]{e}[/yellow]")
        except RunCancelled:
            logger.info("Cancelled by user")
            console.print("[red]Interrupted by user[/red]")
        except Exception as e:
            logger.exception("Unexpected error:")
            console.print(f"[red]Unexpected error: {e}[/red]")
            raise  # re-raise unknown error
        finally:
            remove_sigint()
        return False

    async def _auto_update(self) -> None:
        toast("checking for updates...", topic="update", duration=2.0)
        result = await do_update(print=False, check_only=True)
        if result == UpdateResult.UPDATE_AVAILABLE:
            while True:
                toast(
                    "new version found, run `uv tool upgrade kimi-cli` to upgrade",
                    topic="update",
                    duration=30.0,
                )
                await asyncio.sleep(60.0)
        elif result == UpdateResult.UPDATED:
            toast("auto updated, restart to use the new version", topic="update", duration=5.0)

    def _start_background_task(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)

        def _cleanup(t: asyncio.Task[Any]) -> None:
            self._background_tasks.discard(t)
            try:
                t.result()
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("Background task failed:")

        task.add_done_callback(_cleanup)
        return task


_KIMI_BLUE = "dodger_blue1"
_LOGO = f"""\
[{_KIMI_BLUE}]\
▐█▛█▛█▌
▐█████▌\
[{_KIMI_BLUE}]\
"""


@dataclass(slots=True)
class WelcomeInfoItem:
    class Level(Enum):
        INFO = "grey50"
        WARN = "yellow"
        ERROR = "red"

    name: str
    value: str
    level: Level = Level.INFO


def _print_welcome_info(name: str, info_items: list[WelcomeInfoItem]) -> None:
    head = Text.from_markup("Welcome to Kimi CLI!")
    help_text = Text.from_markup("[grey50]Send /help for help information.[/grey50]")

    # Use Table for precise width control
    logo = Text.from_markup(_LOGO)
    table = Table(show_header=False, show_edge=False, box=None, padding=(0, 1), expand=False)
    table.add_column(justify="left")
    table.add_column(justify="left")
    table.add_row(logo, Group(head, help_text))

    rows: list[RenderableType] = [table]

    if info_items:
        rows.append(Text(""))  # empty line
    for item in info_items:
        rows.append(Text(f"{item.name}: {item.value}", style=item.level.value))

    if LATEST_VERSION_FILE.exists():
        from kimi_cli.constant import VERSION as current_version

        latest_version = LATEST_VERSION_FILE.read_text(encoding="utf-8").strip()
        if semver_tuple(latest_version) > semver_tuple(current_version):
            rows.append(
                Text.from_markup(
                    f"\n[yellow]New version available: {latest_version}. "
                    "Please run `uv tool upgrade kimi-cli` to upgrade.[/yellow]"
                )
            )

    console.print(
        Panel(
            Group(*rows),
            border_style=_KIMI_BLUE,
            expand=False,
            padding=(1, 2),
        )
    )
