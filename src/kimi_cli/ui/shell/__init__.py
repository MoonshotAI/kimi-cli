import asyncio
import signal
from collections.abc import Awaitable, Coroutine
from typing import Any

from kosong.base.message import ContentPart, TextPart, ToolCall, ToolCallPart
from kosong.chat_provider import ChatProviderError
from kosong.tooling import ToolResult
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from kimi_cli.soul import MaxStepsReached, Soul
from kimi_cli.soul.wire import (
    ApprovalRequest,
    ApprovalResponse,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    Wire,
)
from kimi_cli.ui import RunCancelled, run_soul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.liveview import StepLiveView
from kimi_cli.ui.shell.metacmd import get_meta_command
from kimi_cli.ui.shell.prompt import CustomPromptSession, PromptMode, toast
from kimi_cli.ui.shell.update import UpdateResult, do_update
from kimi_cli.utils.logging import logger


class ShellApp:
    def __init__(self, soul: Soul, welcome_info: dict[str, str] | None = None):
        self.soul = soul
        self.welcome_info = welcome_info or {}
        self._background_tasks: set[asyncio.Task[Any]] = set()

    async def run(self, command: str | None = None) -> bool:
        if command is not None:
            # run single command and exit
            logger.info("Running agent with command: {command}", command=command)
            return await self._run(command)

        self._start_auto_update_task()

        _print_welcome_info(self.soul.name or "Kimi CLI", self.welcome_info)

        with CustomPromptSession(lambda: self.soul.status) as prompt_session:
            while True:
                try:
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
                    logger.debug("Exiting by meta command")
                    console.print("Bye!")
                    break

                if user_input.mode == PromptMode.SHELL:
                    await self._run_shell_command(user_input.command)
                    continue

                command = user_input.command
                if command.startswith("/"):
                    logger.debug("Running meta command: {command}", command=command)
                    await self._run_meta_command(command[1:])
                    continue

                logger.info("Running agent command: {command}", command=command)
                await self._run(command)

        return True

    async def _run_shell_command(self, command: str) -> None:
        """Run a shell command in foreground."""
        if not command.strip():
            return

        logger.info("Running shell command: {cmd}", cmd=command)
        loop = asyncio.get_running_loop()
        try:
            # TODO: For the sake of simplicity, we now use `create_subprocess_shell`.
            # Later we should consider making this behave like a real shell.
            proc = await asyncio.create_subprocess_shell(command)

            def _handler():
                logger.debug("SIGINT received.")
                proc.terminate()

            loop.add_signal_handler(signal.SIGINT, _handler)

            await proc.wait()
        except Exception as e:
            logger.exception("Failed to run shell command:")
            console.print(f"[bold red]Failed to run shell command: {e}[/bold red]")
        finally:
            loop.remove_signal_handler(signal.SIGINT)

    async def _run(self, command: str) -> bool:
        """
        Run the soul and handle any known exceptions.

        Returns:
            bool: Whether the run is successful.
        """
        cancel_event = asyncio.Event()

        def _handler():
            logger.debug("SIGINT received.")
            cancel_event.set()

        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGINT, _handler)

        try:
            await run_soul(self.soul, command, self._visualize, cancel_event)
            return True
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            console.print(f"[bold red]LLM provider error: {e}[/bold red]")
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            console.print(f"[bold yellow]Max steps reached: {e.n_steps}[/bold yellow]")
        except RunCancelled:
            logger.info("Cancelled by user")
            console.print("[bold red]Interrupted by user[/bold red]")
        except BaseException as e:
            logger.exception("Unknown error:")
            console.print(f"[bold red]Unknown error: {e}[/bold red]")
            raise  # re-raise unknown error
        finally:
            loop.remove_signal_handler(signal.SIGINT)
        return False

    def _start_auto_update_task(self) -> None:
        self._add_background_task(self._auto_update_background())

    async def _auto_update_background(self) -> None:
        toast("checking for updates...", duration=2.0)
        result = await do_update(print=False)
        if result == UpdateResult.UPDATED:
            toast("auto updated, restart to use the new version", duration=5.0)

    def _add_background_task(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
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

    async def _visualize(self, wire: Wire):
        """
        A loop to consume agent events and visualize the agent behavior.
        This loop never raise any exception except asyncio.CancelledError.
        """
        try:
            # expect a StepBegin
            assert isinstance(await wire.receive(), StepBegin)

            while True:
                # spin the moon at the beginning of each step
                with console.status("", spinner="moon"):
                    msg = await wire.receive()

                with StepLiveView(self.soul.status) as step:
                    # visualization loop for one step
                    while True:
                        match msg:
                            case TextPart(text=text):
                                step.append_text(text)
                            case ContentPart():
                                # TODO: support more content parts
                                step.append_text(f"[{msg.__class__.__name__}]")
                            case ToolCall():
                                step.append_tool_call(msg)
                            case ToolCallPart():
                                step.append_tool_call_part(msg)
                            case ToolResult():
                                step.append_tool_result(msg)
                            case ApprovalRequest():
                                msg.resolve(ApprovalResponse.APPROVE)
                                # TODO(approval): handle approval request
                            case StatusUpdate(status=status):
                                step.update_status(status)
                            case _:
                                break  # break the step loop
                        msg = await wire.receive()

                    # cleanup the step live view
                    if isinstance(msg, StepInterrupted):
                        step.interrupt()
                    else:
                        step.finish()

                if isinstance(msg, StepInterrupted):
                    # for StepInterrupted, the visualization loop should end immediately
                    break

                assert isinstance(msg, StepBegin), "expect a StepBegin"
                # start a new step
        except asyncio.QueueShutDown:
            logger.debug("Visualization loop shutting down")

    async def _run_meta_command(self, command_str: str):
        parts = command_str.split(" ")
        command_name = parts[0]
        command_args = parts[1:]
        command = get_meta_command(command_name)
        if command is None:
            console.print(f"Meta command /{command_name} not found")
            return
        logger.debug(
            "Running meta command: {command_name} with args: {command_args}",
            command_name=command_name,
            command_args=command_args,
        )
        ret = command.func(self, command_args)
        if isinstance(ret, Awaitable):
            await ret


_LOGO = """\
[bold blue]\
▐[on white]█▛█▛█[/on white]▌
▐█████▌\
[/bold blue]\
"""


def _print_welcome_info(name: str, info_items: dict[str, str]) -> None:
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
        rows.append(Text(""))  # Empty line
        rows.extend(
            Text.from_markup(f"[grey50]{key}: {value}[/grey50]")
            for key, value in info_items.items()
        )

    console.print(
        Panel(
            Group(*rows),
            border_style="blue",
            expand=False,
            padding=(1, 2),
        )
    )
