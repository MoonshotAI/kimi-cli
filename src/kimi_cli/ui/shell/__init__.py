from __future__ import annotations

import asyncio
import shlex
from collections.abc import Awaitable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import Any

from kosong.chat_provider import APIStatusError, ChatProviderError
from kosong.message import ContentPart
from loguru import logger
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.prompt import CustomPromptSession, PromptMode, UserInput, toast
from kimi_cli.ui.shell.queue import MessageQueue
from kimi_cli.ui.shell.replay import replay_recent_history
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.ui.shell.update import LATEST_VERSION_FILE, UpdateResult, do_update, semver_tuple
from kimi_cli.ui.shell.visualize import visualize
from kimi_cli.utils.envvar import get_env_bool
from kimi_cli.utils.signals import install_sigint_handler
from kimi_cli.utils.slashcmd import SlashCommand, SlashCommandCall, parse_slash_command_call
from kimi_cli.utils.term import ensure_new_line, ensure_tty_sane
from kimi_cli.wire.message import StatusUpdate


class _InputResult(Enum):
    HANDLED = "handled"
    EXIT = "exit"


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

        # Message queue for background input
        self._message_queue = MessageQueue()
        self._is_running = False  # Flag indicating if a task is currently running
        self._cancelled_needs_confirm = False  # Flag indicating if confirmation is needed

    @property
    def available_slash_commands(self) -> dict[str, SlashCommand[Any]]:
        """Get all available slash commands, including shell-level and soul-level commands."""
        return self._available_slash_commands

    @property
    def message_queue(self) -> MessageQueue:
        """Get the message queue for queue management commands."""
        return self._message_queue

    async def run(self, command: str | None = None) -> bool:
        if command is not None:
            # run single command and exit
            logger.info("Running agent with command: {command}", command=command)
            return await self._run_soul_command(command)

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
            status_provider=self._get_status_with_queue,
            model_capabilities=self.soul.model_capabilities or set(),
            initial_thinking=isinstance(self.soul, KimiSoul) and self.soul.thinking,
            available_slash_commands=list(self._available_slash_commands.values()),
            queue_count_provider=lambda: self._message_queue.pending_count(),
        ) as prompt_session:
            try:
                while True:
                    ensure_tty_sane()

                    # Check if we need confirmation after cancel
                    if self._cancelled_needs_confirm:
                        self._cancelled_needs_confirm = False
                        pending = self._message_queue.list_pending_sync()
                        if pending:
                            console.print("[yellow]Queued messages:[/yellow]")
                            for item in pending:
                                console.print(f"  [yellow][{item.id}] {item.preview}[/yellow]")
                            console.print(
                                "[yellow]Press Enter to continue, or type new input[/yellow]"
                            )

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
                        # Empty input - check if we should process queue
                        if self._message_queue.has_pending():
                            await self._process_queue(prompt_session)
                        continue
                    logger.debug("Got user input: {user_input}", user_input=user_input)

                    result = await self._handle_input(user_input, prompt_session)
                    if result == _InputResult.EXIT:
                        console.print("Bye!")
                        break
            finally:
                ensure_tty_sane()

        return True

    async def _handle_input(
        self, user_input: UserInput, prompt_session: CustomPromptSession
    ) -> _InputResult:
        """Handle a single user input. Returns the result of the input handling."""
        if user_input.command in ["exit", "quit", "/exit", "/quit"]:
            logger.debug("Exiting by slash command")
            return _InputResult.EXIT

        if user_input.mode == PromptMode.SHELL:
            await self._run_shell_command(user_input.command)
            return _InputResult.HANDLED

        if slash_cmd_call := parse_slash_command_call(user_input.command):
            await self._run_slash_command(slash_cmd_call)
            return _InputResult.HANDLED

        await self._run_with_queue_support(user_input, prompt_session)
        return _InputResult.HANDLED

    def _get_status_with_queue(self):
        """Get status snapshot for the prompt toolbar."""
        return self.soul.status

    async def _run_with_queue_support(
        self,
        user_input: UserInput,
        prompt_session: CustomPromptSession,
    ) -> None:
        """Run a soul command with queue support and background input collection."""
        self._is_running = True
        cancelled = False

        try:
            success = await self._run_soul_command_with_bg_input(
                user_input.content, user_input.thinking, prompt_session
            )
            if not success:
                # Task failed, don't auto-process queue
                self._is_running = False
                return
        except RunCancelled:
            cancelled = True
            console.print("[red]Interrupted by user[/red]")
        finally:
            self._is_running = False

        if cancelled:
            # Cancelled - need Enter confirmation before processing queue
            self._cancelled_needs_confirm = True
        else:
            # Natural completion - auto-process queue
            await self._process_queue(prompt_session)

    async def _process_queue(self, prompt_session: CustomPromptSession) -> None:
        """Process the next item in the queue."""
        item = await self._message_queue.dequeue()
        if item is not None:
            console.print(f"[blue]Processing queued [{item.id}]: {item.preview}[/blue]")
            await self._handle_input(item.user_input, prompt_session)

    async def _run_soul_command_with_bg_input(
        self,
        user_input: str | list[ContentPart],
        thinking: bool | None,
        prompt_session: CustomPromptSession,
    ) -> bool:
        """
        Run the soul command while collecting background input.

        New input during execution is added to the queue via the visualize callback.
        """
        cancel_event = asyncio.Event()

        def _sigint_handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, _sigint_handler)

        try:
            if isinstance(self.soul, KimiSoul) and thinking is not None:
                self.soul.set_thinking(thinking)

            await run_soul(
                self.soul,
                user_input,
                lambda wire: visualize(
                    wire.ui_side(merge=False),  # shell UI maintain its own merge buffer
                    initial_status=StatusUpdate(context_usage=self.soul.status.context_usage),
                    cancel_event=cancel_event,
                    message_queue=self._message_queue,
                ),
                cancel_event,
                self.soul.wire_file if isinstance(self.soul, KimiSoul) else None,
            )
            return True
        except LLMNotSet:
            logger.exception("LLM not set:")
            console.print('[red]LLM not set, send "/setup" to configure[/red]')
        except LLMNotSupported as e:
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
            raise  # Re-raise to be handled by caller
        except Exception as e:
            logger.exception("Unexpected error:")
            console.print(f"[red]Unexpected error: {e}[/red]")
            raise
        finally:
            remove_sigint()

        return False

    async def _run_shell_command(self, command: str) -> None:
        """Run a shell command in foreground."""
        if not command.strip():
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
            await self._run_soul_command(command_call.raw_input)
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
        except Exception as e:
            logger.exception("Unknown error:")
            console.print(f"[red]Unknown error: {e}[/red]")
            raise  # re-raise unknown error

    async def _run_soul_command(
        self,
        user_input: str | list[ContentPart],
        thinking: bool | None = None,
    ) -> bool:
        """
        Run the soul and handle any known exceptions.

        Returns:
            bool: Whether the run is successful.
        """
        logger.info(
            "Running soul with user input: {user_input}, thinking {thinking}",
            user_input=user_input,
            thinking=thinking,
        )

        cancel_event = asyncio.Event()

        def _handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        remove_sigint = install_sigint_handler(loop, _handler)

        try:
            if isinstance(self.soul, KimiSoul) and thinking is not None:
                self.soul.set_thinking(thinking)

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
    head = Text.from_markup(f"[bold]Welcome to {name}![/bold]")
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
