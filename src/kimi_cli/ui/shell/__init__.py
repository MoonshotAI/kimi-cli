from __future__ import annotations

import asyncio
import contextlib
import shlex
import time
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from kosong.chat_provider import (
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
)
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from kimi_cli import logger
from kimi_cli.background import list_task_views
from kimi_cli.llm import model_display_name
from kimi_cli.notifications import NotificationManager, NotificationWatcher
from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import update as _update_mod
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.echo import render_user_echo_text
from kimi_cli.ui.shell.mcp_status import render_mcp_prompt
from kimi_cli.ui.shell.prompt import (
    BgTaskCounts,
    CustomPromptSession,
    CwdLostError,
    PromptMode,
    UserInput,
    toast,
)
from kimi_cli.ui.shell.replay import replay_recent_history
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.ui.shell.slash import shell_mode_registry
from kimi_cli.ui.shell.update import LATEST_VERSION_FILE, UpdateResult, do_update, semver_tuple
from kimi_cli.ui.shell.visualize import (
    ApprovalPromptDelegate,
    visualize,
)
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.utils.envvar import get_env_bool
from kimi_cli.utils.logging import open_original_stderr
from kimi_cli.utils.signals import install_sigint_handler
from kimi_cli.utils.slashcmd import SlashCommand, SlashCommandCall, parse_slash_command_call
from kimi_cli.utils.subprocess_env import get_clean_env
from kimi_cli.utils.term import ensure_new_line, ensure_tty_sane
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    ContentPart,
    StatusUpdate,
    WireMessage,
)


@dataclass(slots=True)
class _PromptEvent:
    kind: str
    user_input: UserInput | None = None


_MAX_BG_AUTO_TRIGGER_FAILURES = 3
"""Stop auto-triggering after this many consecutive failures."""

_BG_AUTO_TRIGGER_INPUT_GRACE_S = 0.75
"""Delay background auto-trigger briefly after local prompt activity."""


class _BackgroundCompletionWatcher:
    """Watches for background task completions and auto-triggers the agent.

    Sits between the idle event loop and the soul: when a background task
    finishes while the agent is idle *and* the LLM hasn't consumed the
    notification yet, it triggers a soul run.

    Important: pre-existing pending notifications alone should not trigger a
    foreground run immediately on session resume. They are consumed either by
    the next actual background completion signal or by the next user-triggered
    turn.
    """

    def __init__(
        self,
        soul: Soul,
        *,
        can_auto_trigger_pending: Callable[[], bool] | None = None,
    ) -> None:
        self._event: asyncio.Event | None = None
        self._notifications: NotificationManager | None = None
        self._can_auto_trigger_pending = can_auto_trigger_pending or (lambda: True)
        if isinstance(soul, KimiSoul):
            self._event = soul.runtime.background_tasks.completion_event
            self._notifications = soul.runtime.notifications

    @property
    def enabled(self) -> bool:
        return self._event is not None

    def clear(self) -> None:
        """Clear stale signals from the previous soul run."""
        if self._event is not None:
            self._event.clear()

    async def wait_for_next(self, idle_events: asyncio.Queue[_PromptEvent]) -> _PromptEvent | None:
        """Wait for either a user prompt event or a background completion.

        Returns the prompt event if user input arrived first, or ``None``
        if a background task completed with unclaimed LLM notifications.
        User input always takes priority over background completions.
        """
        if self.enabled and self._has_pending_llm_notifications():
            # Pending notifications already exist (for example after resume).
            # Before the user sends the first foreground turn after resume,
            # pending background notifications should not auto-trigger a run.
            # Once the shell is armed by a user-triggered turn, pending
            # notifications can resume the normal auto-follow-up behavior.
            try:
                return idle_events.get_nowait()
            except asyncio.QueueEmpty:
                if self._can_auto_trigger_pending():
                    return None

        idle_task = asyncio.create_task(idle_events.get())
        if not self.enabled:
            return await idle_task

        assert self._event is not None
        bg_wait_task = asyncio.create_task(self._event.wait())

        done, _ = await asyncio.wait(
            [idle_task, bg_wait_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in (idle_task, bg_wait_task):
            if t not in done:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await t

        if idle_task in done:
            if bg_wait_task in done:
                self._event.clear()
            return idle_task.result()

        # Only bg fired
        self._event.clear()
        if self._has_pending_llm_notifications():
            if self._can_auto_trigger_pending():
                return None
            return _PromptEvent(kind="bg_noop")
        return _PromptEvent(kind="bg_noop")

    def _has_pending_llm_notifications(self) -> bool:
        if self._notifications is None:
            return False
        return self._notifications.has_pending_for_sink("llm")


class _BackgroundAutoTriggerPromptState(Protocol):
    def has_pending_input(self) -> bool: ...

    def had_recent_input_activity(self, *, within_s: float) -> bool: ...

    def recent_input_activity_remaining(self, *, within_s: float) -> float: ...

    async def wait_for_input_activity(self) -> None: ...


class Shell:
    def __init__(
        self,
        soul: Soul,
        welcome_info: list[WelcomeInfoItem] | None = None,
        prefill_text: str | None = None,
    ):
        self.soul = soul
        self._welcome_info = list(welcome_info or [])
        self._prefill_text = prefill_text
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._prompt_session: CustomPromptSession | None = None
        self._running_input_handler: Callable[[UserInput], None] | None = None
        self._running_interrupt_handler: Callable[[], None] | None = None
        self._active_approval_sink: Any | None = None
        self._active_view: Any | None = None
        self._pending_approval_requests = deque[ApprovalRequest]()
        self._current_prompt_approval_request: ApprovalRequest | None = None
        self._approval_modal: ApprovalPromptDelegate | None = None
        self._exit_after_run = False
        self._available_slash_commands: dict[str, SlashCommand[Any]] = {
            **{cmd.name: cmd for cmd in soul.available_slash_commands},
            **{cmd.name: cmd for cmd in shell_slash_registry.list_commands()},
        }
        """Shell-level slash commands + soul-level slash commands. Name to command mapping."""

    @property
    def available_slash_commands(self) -> dict[str, SlashCommand[Any]]:
        """Get all available slash commands, including shell-level and soul-level commands."""
        return self._available_slash_commands

    def _print_cwd_lost_crash(self) -> None:
        """Print a crash report when the working directory is no longer accessible."""
        runtime = self.soul.runtime if isinstance(self.soul, KimiSoul) else None
        session_id = runtime.session.id if runtime else "unknown"
        work_dir = str(runtime.session.work_dir) if runtime else "unknown"

        info = Table.grid(padding=(0, 1))
        info.add_row("Session:", session_id)
        info.add_row("Working directory:", work_dir)

        panel = Panel(
            Group(
                Text(
                    "The working directory is no longer accessible "
                    "(external drive unplugged, directory deleted, or filesystem unmounted).",
                ),
                Text(""),
                info,
                Text(""),
                Text(
                    "Your conversation history has been saved. "
                    "Restart kimi in a valid directory to continue.",
                    style="dim",
                ),
            ),
            title="[bold red]Session crashed[/bold red]",
            border_style="red",
        )
        console.print()
        console.print(panel)

    @staticmethod
    def _should_exit_input(user_input: UserInput) -> bool:
        return user_input.command.strip() in {"exit", "quit", "/exit", "/quit"}

    @staticmethod
    def _agent_slash_command_call(user_input: UserInput) -> SlashCommandCall | None:
        if user_input.mode != PromptMode.AGENT:
            return None
        display_call = parse_slash_command_call(user_input.command)
        if display_call is None:
            return None
        resolved_call = parse_slash_command_call(user_input.resolved_command)
        if resolved_call is None or resolved_call.name != display_call.name:
            return display_call
        return resolved_call

    @staticmethod
    def _should_echo_agent_input(user_input: UserInput) -> bool:
        if user_input.mode != PromptMode.AGENT:
            return False
        if Shell._should_exit_input(user_input):
            return False
        return Shell._agent_slash_command_call(user_input) is None

    @staticmethod
    def _echo_agent_input(user_input: UserInput) -> None:
        console.print(render_user_echo_text(user_input.command))

    def _bind_running_input(
        self,
        on_input: Callable[[UserInput], None],
        on_interrupt: Callable[[], None],
    ) -> None:
        self._running_input_handler = on_input
        self._running_interrupt_handler = on_interrupt

    def _unbind_running_input(self) -> None:
        self._running_input_handler = None
        self._running_interrupt_handler = None

    async def _route_prompt_events(
        self,
        prompt_session: CustomPromptSession,
        idle_events: asyncio.Queue[_PromptEvent],
        resume_prompt: asyncio.Event,
    ) -> None:
        while True:
            # Keep exactly one active prompt read. Idle submissions pause the
            # router until the shell decides whether the next prompt should
            # wait for a blocking action or stay live during an agent run.
            await resume_prompt.wait()
            ensure_tty_sane()
            try:
                ensure_new_line()
                user_input = await prompt_session.prompt_next()
            except KeyboardInterrupt:
                logger.debug("Prompt router got KeyboardInterrupt")
                if (
                    self._running_input_handler is not None
                    and prompt_session.running_prompt_accepts_submission()
                ):
                    if self._running_interrupt_handler is not None:
                        self._running_interrupt_handler()
                    continue
                resume_prompt.clear()
                await idle_events.put(_PromptEvent(kind="interrupt"))
                continue
            except EOFError:
                logger.debug("Prompt router got EOF")
                if (
                    self._running_input_handler is not None
                    and prompt_session.running_prompt_accepts_submission()
                ):
                    self._exit_after_run = True
                    if self._running_interrupt_handler is not None:
                        self._running_interrupt_handler()
                    return
                resume_prompt.clear()
                await idle_events.put(_PromptEvent(kind="eof"))
                return
            except CwdLostError:
                logger.error("Working directory no longer exists")
                resume_prompt.clear()
                await idle_events.put(_PromptEvent(kind="cwd_lost"))
                return
            except Exception:
                logger.exception("Prompt router crashed")
                resume_prompt.clear()
                await idle_events.put(_PromptEvent(kind="error"))
                return

            if prompt_session.last_submission_was_running:  # noqa: SIM102
                if self._running_input_handler is not None:
                    if user_input:
                        self._running_input_handler(user_input)
                    continue
                # Handler already unbound — fall through to idle path.

            resume_prompt.clear()
            await idle_events.put(_PromptEvent(kind="input", user_input=user_input))

    async def run(self, command: str | None = None) -> bool:
        _run_start_time = time.monotonic()

        # Initialize theme from config
        if isinstance(self.soul, KimiSoul):
            from kimi_cli.ui.theme import set_active_theme

            set_active_theme(self.soul.runtime.config.theme)

        if command is not None:
            # run single command and exit
            logger.info("Running agent with command: {command}", command=command)
            if isinstance(self.soul, KimiSoul):
                self._start_background_task(self._watch_root_wire_hub())
            try:
                return await self.run_soul_command(command)
            finally:
                self._cancel_background_tasks()

        # Start auto-update background task if not disabled
        if get_env_bool("KIMI_CLI_NO_AUTO_UPDATE"):
            logger.info("Auto-update disabled by KIMI_CLI_NO_AUTO_UPDATE environment variable")
        else:
            self._start_background_task(self._auto_update())

        _print_welcome_info(self.soul.name or "Kimi Code CLI", self._welcome_info)

        # Start telemetry periodic flush and disk retry
        from kimi_cli.telemetry import get_sink

        _telemetry_sink = get_sink()
        if _telemetry_sink is not None:
            _telemetry_sink.start_periodic_flush()
            self._start_background_task(_telemetry_sink.retry_disk_events())

        if isinstance(self.soul, KimiSoul):
            watcher = NotificationWatcher(
                self.soul.runtime.notifications,
                sink="shell",
                before_poll=self.soul.runtime.background_tasks.reconcile,
                on_notification=lambda notification: toast(
                    f"[{notification.event.type}] {notification.event.title}",
                    topic="notification",
                    duration=10.0,
                ),
            )
            self._start_background_task(watcher.run_forever())
            self._start_background_task(self._watch_root_wire_hub())
            await replay_recent_history(
                self.soul.context.history,
                wire_file=self.soul.wire_file,
                show_thinking_stream=self.soul.runtime.config.show_thinking_stream,
            )
            await self.soul.start_background_mcp_loading()

        async def _plan_mode_toggle() -> bool:
            if isinstance(self.soul, KimiSoul):
                return await self.soul.toggle_plan_mode_from_manual()
            return False

        def _mcp_status_block(columns: int):
            if not isinstance(self.soul, KimiSoul):
                return None
            snapshot = self.soul.status.mcp_status
            if snapshot is None:
                return None
            return render_mcp_prompt(snapshot)

        def _mcp_status_loading() -> bool:
            if not isinstance(self.soul, KimiSoul):
                return False
            snapshot = self.soul.status.mcp_status
            return bool(snapshot and snapshot.loading)

        @dataclass
        class _BgCountCache:
            time: float = 0.0
            counts: BgTaskCounts = BgTaskCounts()

        _bg_cache = _BgCountCache()

        def _bg_task_counts() -> BgTaskCounts:
            if not isinstance(self.soul, KimiSoul):
                return BgTaskCounts()
            now = time.monotonic()
            if now - _bg_cache.time < 1.0:
                return _bg_cache.counts
            views = list_task_views(self.soul.runtime.background_tasks, active_only=True)
            bash_n = sum(1 for v in views if v.spec.kind == "bash")
            agent_n = sum(1 for v in views if v.spec.kind == "agent")
            _bg_cache.counts = BgTaskCounts(bash=bash_n, agent=agent_n)
            _bg_cache.time = now
            return _bg_cache.counts

        with CustomPromptSession(
            status_provider=lambda: self.soul.status,
            status_block_provider=_mcp_status_block,
            fast_refresh_provider=_mcp_status_loading,
            background_task_count_provider=_bg_task_counts,
            model_capabilities=self.soul.model_capabilities or set(),
            model_name=model_display_name(
                self.soul.model_name,
                self.soul.runtime.llm.model_config
                if isinstance(self.soul, KimiSoul) and self.soul.runtime.llm
                else None,
            ),
            thinking=self.soul.thinking or False,
            agent_mode_slash_commands=list(self._available_slash_commands.values()),
            shell_mode_slash_commands=shell_mode_registry.list_commands(),
            editor_command_provider=lambda: (
                self.soul.runtime.config.default_editor if isinstance(self.soul, KimiSoul) else ""
            ),
            plan_mode_toggle_callback=_plan_mode_toggle,
        ) as prompt_session:
            self._prompt_session = prompt_session
            if self._prefill_text:
                prompt_session.set_prefill_text(self._prefill_text)
                self._prefill_text = None
            if isinstance(self.soul, KimiSoul):
                kimi_soul = self.soul
                snapshot = kimi_soul.status.mcp_status
                if snapshot and snapshot.loading:

                    async def _invalidate_after_mcp_loading() -> None:
                        try:
                            await kimi_soul.wait_for_background_mcp_loading()
                        except Exception:
                            logger.debug("MCP loading finished with error while refreshing prompt")
                        if self._prompt_session is prompt_session:
                            prompt_session.invalidate()

                    self._start_background_task(_invalidate_after_mcp_loading())
            self._exit_after_run = False
            idle_events: asyncio.Queue[_PromptEvent] = asyncio.Queue()
            # resume_prompt controls whether the prompt router reads input.
            # Set BEFORE an await = prompt stays live during the operation
            # (agent runs that accept steer input); set AFTER = prompt is
            # paused until the operation finishes.
            resume_prompt = asyncio.Event()
            resume_prompt.set()
            prompt_task = asyncio.create_task(
                self._route_prompt_events(prompt_session, idle_events, resume_prompt)
            )
            background_autotrigger_armed = False

            def _can_auto_trigger_pending() -> bool:
                return background_autotrigger_armed

            bg_watcher = _BackgroundCompletionWatcher(
                self.soul,
                can_auto_trigger_pending=_can_auto_trigger_pending,
            )

            shell_ok = True
            bg_auto_failures = 0
            deferred_bg_trigger = False
            try:
                while True:
                    if deferred_bg_trigger and not self._should_defer_background_auto_trigger(
                        prompt_session
                    ):
                        result = None
                    elif deferred_bg_trigger:
                        result = await self._wait_for_input_or_activity(
                            prompt_session,
                            idle_events,
                            timeout_s=self._background_auto_trigger_timeout_s(prompt_session),
                        )
                    else:
                        bg_watcher.clear()
                        if bg_auto_failures >= _MAX_BG_AUTO_TRIGGER_FAILURES:
                            result = await idle_events.get()
                        else:
                            result = await bg_watcher.wait_for_next(idle_events)

                    if result is None:
                        if self._should_defer_background_auto_trigger(prompt_session):
                            deferred_bg_trigger = True
                            resume_prompt.set()
                            continue
                        deferred_bg_trigger = False
                        logger.info("Background task completed while idle, triggering agent")
                        resume_prompt.set()
                        ok = await self.run_soul_command(
                            "<system-reminder>"
                            "Background tasks completed while you"
                            " were idle."
                            "</system-reminder>"
                        )
                        console.print()
                        if not ok:
                            bg_auto_failures += 1
                            logger.warning(
                                "Background auto-trigger failed ({n}/{max})",
                                n=bg_auto_failures,
                                max=_MAX_BG_AUTO_TRIGGER_FAILURES,
                            )
                        else:
                            bg_auto_failures = 0
                        if self._exit_after_run:
                            console.print("Bye!")
                            break
                        continue

                    event = result

                    if event.kind == "input_activity":
                        continue

                    if event.kind == "bg_noop":
                        continue

                    if event.kind == "interrupt":
                        console.print("[grey50]Tip: press Ctrl-D or send 'exit' to quit[/grey50]")
                        resume_prompt.set()
                        continue

                    if event.kind == "eof":
                        console.print("Bye!")
                        break

                    if event.kind == "cwd_lost":
                        self._print_cwd_lost_crash()
                        shell_ok = False
                        break

                    if event.kind == "error":
                        shell_ok = False
                        break

                    user_input = event.user_input
                    assert user_input is not None
                    bg_auto_failures = 0
                    deferred_bg_trigger = False
                    if not user_input:
                        logger.debug("Got empty input, skipping")
                        resume_prompt.set()
                        continue
                    logger.debug("Got user input: {user_input}", user_input=user_input)

                    if self._should_echo_agent_input(user_input):
                        self._echo_agent_input(user_input)

                    if self._should_exit_input(user_input):
                        logger.debug("Exiting by slash command")
                        console.print("Bye!")
                        break

                    if user_input.mode == PromptMode.SHELL:
                        await self._run_shell_command(user_input.command)
                        resume_prompt.set()
                        continue

                    # Unified input routing — intercept local commands
                    # before they reach the soul/wire.
                    from kimi_cli.ui.shell.visualize import InputAction, classify_input

                    # Use resolved_command (placeholder-expanded) so /btw
                    # receives the actual pasted content, not "[Pasted text #1]".
                    input_text = (
                        user_input.resolved_command
                        if hasattr(user_input, "resolved_command")
                        else str(user_input)
                    )
                    action = classify_input(input_text, is_streaming=False)
                    if action.kind == InputAction.BTW and isinstance(self.soul, KimiSoul):
                        from kimi_cli.telemetry import track

                        track("input_btw")
                        await self._run_btw_modal(action.args, prompt_session)
                        resume_prompt.set()
                        continue
                    if action.kind == InputAction.IGNORED:
                        console.print(f"[dim]{action.args}[/dim]")
                        resume_prompt.set()
                        continue

                    if slash_cmd_call := self._agent_slash_command_call(user_input):
                        is_soul_slash = (
                            slash_cmd_call.name in self._available_slash_commands
                            and shell_slash_registry.find_command(slash_cmd_call.name) is None
                        )
                        if is_soul_slash:
                            from kimi_cli.telemetry import track

                            track("input_command", command=slash_cmd_call.name)
                            background_autotrigger_armed = True
                            resume_prompt.set()
                            await self.run_soul_command(slash_cmd_call.raw_input)
                            console.print()
                            if self._exit_after_run:
                                console.print("Bye!")
                                break
                        else:
                            await self._run_slash_command(slash_cmd_call)
                            resume_prompt.set()
                        continue

                    background_autotrigger_armed = True
                    resume_prompt.set()
                    await self.run_soul_command(user_input.content)
                    console.print()
                    if self._exit_after_run:
                        console.print("Bye!")
                        break
            finally:
                prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await prompt_task
                self._running_input_handler = None
                self._running_interrupt_handler = None
                if self._prompt_session is prompt_session and self._approval_modal is not None:
                    prompt_session.detach_modal(self._approval_modal)
                    self._approval_modal = None
                self._prompt_session = None
                self._cancel_background_tasks()
                # Track exit and flush remaining telemetry events.
                # Cap the exit-path flush at 3 s so we don't block for ~50 s
                # when the endpoint is unreachable (in-process retry backoff).
                # On timeout the CancelledError handler in transport.send()
                # persists in-flight events to disk; flush_sync() catches any
                # events still in the buffer.
                from kimi_cli.telemetry import track

                track("exit", duration_s=time.monotonic() - _run_start_time)
                if _telemetry_sink is not None:
                    _telemetry_sink.stop_periodic_flush()
                    try:
                        await asyncio.wait_for(_telemetry_sink.flush(), timeout=3.0)
                    except (TimeoutError, Exception):
                        _telemetry_sink.flush_sync()
                ensure_tty_sane()

        return shell_ok

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
        split_cmd: list[str] | None = None
        try:
            split_cmd = shlex.split(stripped_cmd)
        except ValueError as exc:
            logger.debug("Failed to parse shell command for cd check: {error}", error=exc)
        if split_cmd and len(split_cmd) == 2 and split_cmd[0] == "cd":
            console.print(
                "[yellow]Warning: Directory changes are not preserved across command executions."
                "[/yellow]"
            )
            return

        logger.info("Running shell command: {cmd}", cmd=command)
        from kimi_cli.telemetry import track

        track("input_bash")

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
            with open_original_stderr() as stderr:
                kwargs: dict[str, Any] = {}
                if stderr is not None:
                    kwargs["stderr"] = stderr
                proc = await asyncio.create_subprocess_shell(command, env=get_clean_env(), **kwargs)
                await proc.wait()
        except Exception as e:
            logger.exception("Failed to run shell command:")
            console.print(f"[red]Failed to run shell command: {e}[/red]")
        finally:
            remove_sigint()

    async def _run_slash_command(self, command_call: SlashCommandCall) -> None:
        from kimi_cli.cli import Reload, SwitchToVis, SwitchToWeb
        from kimi_cli.telemetry import track

        if command_call.name not in self._available_slash_commands:
            logger.info("Unknown slash command /{command}", command=command_call.name)
            track("input_command_invalid")
            console.print(
                f'[red]Unknown slash command "/{command_call.name}", '
                'type "/" for all available commands[/red]'
            )
            return

        track("input_command", command=command_call.name)

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
        except (Reload, SwitchToWeb, SwitchToVis):
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

        # Declare before try so finally can always access it.
        from kimi_cli.ui.shell.visualize import (
            _PromptLiveView,  # pyright: ignore[reportPrivateUsage]
        )

        captured_view: _PromptLiveView | None = None
        pending: list[UserInput] = []  # queued messages being drained

        try:
            snap = self.soul.status
            runtime = self.soul.runtime if isinstance(self.soul, KimiSoul) else None
            show_thinking_stream = runtime.config.show_thinking_stream if runtime else False
            # Capture view reference via closure — _clear_active_view sets
            # _active_view=None inside visualize()'s finally (before run_soul
            # returns), so we must capture the view object independently.

            def _on_view_ready(view: Any) -> None:
                nonlocal captured_view
                self._set_active_view(view)
                if isinstance(view, _PromptLiveView):
                    captured_view = view

            await run_soul(
                self.soul,
                user_input,
                lambda wire: visualize(
                    wire.ui_side(merge=False),  # shell UI maintain its own merge buffer
                    initial_status=StatusUpdate(
                        context_usage=snap.context_usage,
                        context_tokens=snap.context_tokens,
                        max_context_tokens=snap.max_context_tokens,
                        mcp_status=snap.mcp_status,
                    ),
                    cancel_event=cancel_event,
                    prompt_session=self._prompt_session,
                    steer=self.soul.steer if isinstance(self.soul, KimiSoul) else None,
                    btw_runner=self._make_btw_runner(),
                    bind_running_input=self._bind_running_input,
                    unbind_running_input=self._unbind_running_input,
                    on_view_ready=_on_view_ready,
                    on_view_closed=self._clear_active_view,
                    show_thinking_stream=show_thinking_stream,
                ),
                cancel_event,
                runtime.session.wire_file if runtime else None,
                runtime,
            )
            # If btw is still showing, wait for user dismiss BEFORE draining
            # queue.  This runs AFTER visualize_loop returns (within run_soul's
            # 0.5s ui_task timeout), so the btw modal is still attached to
            # prompt_session and key events continue to work.
            if captured_view is not None:
                await captured_view.wait_for_btw_dismiss()

            # Clear cancel_event so queued turns aren't tainted by a
            # Ctrl+C that fired during btw dismiss wait.
            cancel_event.clear()

            # Drain queued messages and send each as a new turn.
            # Safety valve: cap at 20 "generations" (new batches of messages
            # from the view). A one-time backlog of 25 messages = 1 generation,
            # but a user adding new messages every turn = 1 generation per turn.
            _MAX_DRAIN_GENERATIONS = 20
            pending.clear()
            drain_generation = 0
            while captured_view is not None and drain_generation < _MAX_DRAIN_GENERATIONS:
                new_messages = captured_view.drain_queued_messages()
                if new_messages:
                    drain_generation += 1
                pending.extend(new_messages)
                if not pending:
                    break
                queued = pending.pop(0)
                console.print(render_user_echo_text(queued.command))
                await run_soul(
                    self.soul,
                    queued.content,
                    lambda wire: visualize(
                        wire.ui_side(merge=False),
                        initial_status=StatusUpdate(
                            context_usage=self.soul.status.context_usage,
                            context_tokens=self.soul.status.context_tokens,
                            max_context_tokens=self.soul.status.max_context_tokens,
                            mcp_status=self.soul.status.mcp_status,
                        ),
                        cancel_event=cancel_event,
                        prompt_session=self._prompt_session,
                        steer=self.soul.steer if isinstance(self.soul, KimiSoul) else None,
                        btw_runner=self._make_btw_runner(),
                        bind_running_input=self._bind_running_input,
                        unbind_running_input=self._unbind_running_input,
                        on_view_ready=_on_view_ready,
                        on_view_closed=self._clear_active_view,
                        show_thinking_stream=show_thinking_stream,
                    ),
                    cancel_event,
                    runtime.session.wire_file if runtime else None,
                    runtime,
                )
                # Wait for btw dismiss if one was triggered during this queued turn
                if captured_view is not None:
                    await captured_view.wait_for_btw_dismiss()
                cancel_event.clear()  # same rationale as above
                # captured_view is now the view from this turn;
                # next iteration drains it for any new messages.
            if drain_generation >= _MAX_DRAIN_GENERATIONS:
                logger.warning(
                    "Queue drain hit safety limit ({n} generations)",
                    n=_MAX_DRAIN_GENERATIONS,
                )
                # Warn about remaining items in the local pending buffer.
                # Clear after printing so finally doesn't duplicate.
                for msg in pending:
                    console.print(f"[yellow]Queued message dropped: {msg.command}[/yellow]")
                pending.clear()
            return True
        except LLMNotSet:
            logger.exception("LLM not set:")
            console.print('[red]LLM not set, send "/login" to login[/red]')
        except LLMNotSupported as e:
            # actually unsupported input/mode should already be blocked by prompt session
            logger.exception("LLM not supported:")
            console.print(f"[red]{e}[/red]")
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            if isinstance(e, APIStatusError) and e.status_code == 401:
                console.print(
                    "[red]Authorization failed. Your session may have expired.[/red]\n"
                    "[dim]Type [bold]/login[/bold] to re-authenticate.[/dim]\n"
                    f"[dim]Server: {e}[/dim]"
                )
            elif isinstance(e, APIStatusError) and e.status_code == 402:
                console.print(
                    f"[red]Membership expired, please renew your plan[/red]\n[dim]Server: {e}[/dim]"
                )
            elif isinstance(e, APIStatusError) and e.status_code == 403:
                console.print(
                    "[red]Quota exceeded, please upgrade your plan or retry later[/red]\n"
                    f"[dim]Server: {e}[/dim]"
                )
            elif isinstance(e, APIConnectionError):
                console.print(
                    f"[red]Network connection failed: {e}[/red]\n"
                    "[dim]Please check your network and try again.[/dim]"
                )
            elif isinstance(e, APITimeoutError):
                console.print(
                    f"[red]Request timed out: {e}[/red]\n"
                    "[dim]The server may be slow or unreachable. Please try again later.[/dim]"
                )
            elif isinstance(e, APIEmptyResponseError):
                console.print(
                    "[red]The server returned an empty response.[/red]\n"
                    "[dim]This is usually a temporary issue. Please try again.[/dim]"
                )
            else:
                console.print(f"[red]LLM provider error: {e}[/red]")
            if not isinstance(e, APIStatusError) or e.status_code not in (401, 402, 403):
                console.print(
                    "[dim]If this persists, run [bold]kimi export[/bold] and send the "
                    "exported data to support for assistance. "
                    "Please do not share the exported file publicly.[/dim]"
                )
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            console.print(
                f"[yellow]{e}[/yellow]\n"
                "[dim]Send another message to continue where it left off.[/dim]"
            )
        except RunCancelled:
            logger.info("Cancelled by user")
            from kimi_cli.telemetry import track

            _at_step = (
                getattr(self.soul, "_current_step_no", 0) if isinstance(self.soul, KimiSoul) else 0
            )
            track("turn_interrupted", at_step=_at_step)
            console.print("[red]Interrupted by user[/red]")
        except Exception as e:
            logger.exception("Unexpected error:")
            console.print(
                f"[red]Unexpected error: {e}[/red]\n"
                "[dim]Run [bold]kimi export[/bold] and send the exported data to support "
                "for assistance. Please do not share the exported file publicly.[/dim]"
            )
            raise  # re-raise unknown error
        finally:
            # Clean up btw modal if it's still attached (exception skipped wait_for_btw_dismiss)
            if captured_view is not None:
                captured_view._dismiss_btw()  # pyright: ignore[reportPrivateUsage]
            # Warn about queued messages lost due to error/cancel.
            # Check both: pending (already drained from view) and view (not yet drained).
            all_lost: list[UserInput] = list(pending)
            pending.clear()
            if captured_view is not None:
                all_lost.extend(captured_view.drain_queued_messages())
            for msg in all_lost:
                console.print(f"[yellow]Queued message dropped: {msg.command}[/yellow]")
            self._maybe_present_pending_approvals()
            remove_sigint()
        return False

    @staticmethod
    def _should_defer_background_auto_trigger(
        prompt_session: _BackgroundAutoTriggerPromptState | None,
    ) -> bool:
        if prompt_session is None:
            return False
        return prompt_session.has_pending_input() or prompt_session.had_recent_input_activity(
            within_s=_BG_AUTO_TRIGGER_INPUT_GRACE_S
        )

    @staticmethod
    def _background_auto_trigger_timeout_s(
        prompt_session: _BackgroundAutoTriggerPromptState | None,
    ) -> float | None:
        if prompt_session is None or prompt_session.has_pending_input():
            return None
        remaining = prompt_session.recent_input_activity_remaining(
            within_s=_BG_AUTO_TRIGGER_INPUT_GRACE_S
        )
        return remaining if remaining > 0 else None

    async def _wait_for_input_or_activity(
        self,
        prompt_session: _BackgroundAutoTriggerPromptState,
        idle_events: asyncio.Queue[_PromptEvent],
        *,
        timeout_s: float | None = None,
    ) -> _PromptEvent:
        idle_task = asyncio.create_task(idle_events.get())
        activity_task = asyncio.create_task(prompt_session.wait_for_input_activity())
        timeout_task = (
            asyncio.create_task(asyncio.sleep(timeout_s)) if timeout_s is not None else None
        )
        done: set[asyncio.Task[Any]] = set()
        try:
            done, _ = await asyncio.wait(
                [task for task in (idle_task, activity_task, timeout_task) if task is not None],
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for task in (idle_task, activity_task, timeout_task):
                if task is None:
                    continue
                if task.done():
                    continue
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

        if idle_task in done:
            return idle_task.result()
        return _PromptEvent(kind="input_activity")

    async def _watch_root_wire_hub(self) -> None:
        if not isinstance(self.soul, KimiSoul):
            return
        if self.soul.runtime.root_wire_hub is None:
            return
        queue = self.soul.runtime.root_wire_hub.subscribe()
        try:
            while True:
                try:
                    msg = await queue.get()
                except QueueShutDown:
                    return
                try:
                    await self._handle_root_hub_message(msg)
                except Exception:
                    logger.exception("Failed to handle root hub message:")
        finally:
            self.soul.runtime.root_wire_hub.unsubscribe(queue)

    async def _handle_root_hub_message(self, msg: WireMessage) -> None:
        if not isinstance(self.soul, KimiSoul):
            return
        match msg:
            case ApprovalRequest() as request:
                request = self._enrich_approval_request_for_ui(request)
                if self.soul.runtime.approval_runtime is None:
                    return
                record = self.soul.runtime.approval_runtime.get_request(request.id)
                if record is None or record.status != "pending":
                    return
                if self._prompt_session is not None:
                    # Interactive mode: queue and present via modal
                    self._queue_approval_request(request)
                    self._maybe_present_pending_approvals()
                    self._prompt_session.invalidate()
                elif self._active_approval_sink is not None:
                    # Non-interactive with live view: forward to sink
                    self._forward_approval_to_sink(request)
                else:
                    # Queue for later
                    self._queue_approval_request(request)
            case ApprovalResponse() as response:
                # External resolution (e.g. from web UI)
                if (
                    self._approval_modal is not None
                    and self._approval_modal.request.id == response.request_id
                ):
                    if not self._approval_modal.request.resolved:
                        self._approval_modal.request.resolve(response.response)
                    self._clear_current_prompt_approval_request(response.request_id)
                    self._activate_prompt_approval_modal()
                self._remove_pending_approval_request(response.request_id)
                self._maybe_present_pending_approvals()
                if self._prompt_session is not None:
                    self._prompt_session.invalidate()
            case _:
                return

    def _enrich_approval_request_for_ui(self, request: ApprovalRequest) -> ApprovalRequest:
        if not isinstance(self.soul, KimiSoul):
            return request
        if request.agent_id is None:
            return request
        if self.soul.runtime.subagent_store is None:
            return request
        record = self.soul.runtime.subagent_store.get_instance(request.agent_id)
        if record is None:
            return request
        return request.model_copy(update={"source_description": record.description})

    async def _run_btw_modal(
        self,
        question: str,
        prompt_session: CustomPromptSession,
    ) -> None:
        """Run /btw using the prompt session's modal system.

        Attaches a ``_BtwModalDelegate`` that replaces the input line with
        the btw panel.  A refresh loop animates the spinner.  After the LLM
        responds, we start a new prompt read so prompt_toolkit can render the
        result and accept dismiss keys.
        """
        from kimi_cli.soul.btw import execute_side_question
        from kimi_cli.ui.shell.visualize import (
            _BtwModalDelegate,  # pyright: ignore[reportPrivateUsage]
        )

        assert isinstance(self.soul, KimiSoul)

        dismiss_event = asyncio.Event()
        modal = _BtwModalDelegate(on_dismiss=lambda: dismiss_event.set())
        import time

        modal._question = question  # pyright: ignore[reportPrivateUsage]
        modal.set_start_time(time.monotonic())
        prompt_session.attach_modal(modal)

        # Refresh loop for spinner animation
        async def _refresh() -> None:
            try:
                while True:
                    await asyncio.sleep(0.08)
                    prompt_session.invalidate()
            except asyncio.CancelledError:
                pass

        refresh_task = asyncio.create_task(_refresh())
        prompt_task: asyncio.Task[None] | None = None
        llm_task: asyncio.Task[tuple[str | None, str | None]] | None = None

        try:

            def _on_chunk(chunk: str) -> None:
                modal.append_text(chunk)

            # Start a prompt read concurrently — renders the modal and
            # handles key events while the LLM call runs in parallel.
            async def _wait_for_dismiss() -> None:
                while not dismiss_event.is_set():
                    try:
                        await prompt_session.prompt_next()
                    except (KeyboardInterrupt, EOFError):
                        dismiss_event.set()
                        break

            prompt_task = asyncio.create_task(_wait_for_dismiss())

            # Run LLM call as a separate task so Escape can cancel it
            llm_task = asyncio.create_task(
                execute_side_question(self.soul, question, on_text_chunk=_on_chunk)
            )

            # Wait for either LLM completion or user dismiss
            dismiss_task = asyncio.create_task(dismiss_event.wait())
            _done, _ = await asyncio.wait(
                [llm_task, dismiss_task],
                return_when=asyncio.FIRST_COMPLETED,
            )

            if llm_task.done() and not llm_task.cancelled():
                # LLM finished — show result, wait for user to dismiss
                dismiss_task.cancel()
                response, error = llm_task.result()
                modal.set_result(response, error)
                prompt_session.invalidate()
                await dismiss_event.wait()
            else:
                # User dismissed during loading — cancel the LLM call
                llm_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await llm_task
        finally:
            # Cancel ALL child tasks
            if llm_task is not None and not llm_task.done():
                llm_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await llm_task
            if prompt_task is not None:
                prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await prompt_task
            refresh_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await refresh_task
            prompt_session.detach_modal(modal)

    def _make_btw_runner(self):
        """Create a btw_runner callback bound to the current soul."""
        if not isinstance(self.soul, KimiSoul):
            return None

        soul = self.soul

        async def _runner(
            question: str,
            on_text_chunk: Callable[[str], None] | None = None,
        ) -> tuple[str | None, str | None]:
            from kimi_cli.soul.btw import execute_side_question

            return await execute_side_question(soul, question, on_text_chunk)

        return _runner

    def _set_active_view(self, view: Any) -> None:
        self._active_approval_sink = view
        self._active_view = view
        # In interactive mode, approvals are handled by the prompt modal,
        # not by the live view sink. Don't flush to avoid losing requests.
        if self._prompt_session is not None:
            return
        # Flush pending approvals to the newly active sink
        while self._pending_approval_requests:
            request = self._pending_approval_requests.popleft()

            if not isinstance(self.soul, KimiSoul) or self.soul.runtime.approval_runtime is None:
                break
            record = self.soul.runtime.approval_runtime.get_request(request.id)
            if record is None or record.status != "pending":
                continue
            self._forward_approval_to_sink(request)

    def _clear_active_view(self) -> None:
        self._active_approval_sink = None
        self._active_view = None
        # Re-queue any approval requests that were forwarded to the sink
        # but not yet resolved.  Without this, those requests would be
        # silently lost when the live view closes between turns.
        if not isinstance(self.soul, KimiSoul) or self.soul.runtime.approval_runtime is None:
            return
        for record in self.soul.runtime.approval_runtime.list_pending():
            self._queue_approval_request(
                self._enrich_approval_request_for_ui(
                    ApprovalRequest(
                        id=record.id,
                        tool_call_id=record.tool_call_id,
                        sender=record.sender,
                        action=record.action,
                        description=record.description,
                        display=record.display,
                        source_kind=record.source.kind,
                        source_id=record.source.id,
                        agent_id=record.source.agent_id,
                        subagent_type=record.source.subagent_type,
                    )
                )
            )

    def _forward_approval_to_sink(self, request: ApprovalRequest) -> None:
        """Forward an approval request to the active live view sink and bridge the response."""
        if self._active_approval_sink is None:
            self._queue_approval_request(request)
            return
        self._active_approval_sink.enqueue_external_message(request)

        async def _bridge() -> None:
            try:
                response = await request.wait()
                if (
                    isinstance(self.soul, KimiSoul)
                    and self.soul.runtime.approval_runtime is not None
                ):
                    self.soul.runtime.approval_runtime.resolve(
                        request.id, response, feedback=request.feedback
                    )
            finally:
                if self._prompt_session is not None:
                    self._prompt_session.invalidate()

        self._start_background_task(_bridge())

    def _queue_approval_request(self, request: ApprovalRequest) -> None:
        if self._approval_modal is not None and self._approval_modal.request.id == request.id:
            return
        if (
            self._current_prompt_approval_request is not None
            and self._current_prompt_approval_request.id == request.id
        ):
            return
        if any(r.id == request.id for r in self._pending_approval_requests):
            return
        self._pending_approval_requests.append(request)

    def _remove_pending_approval_request(self, request_id: str) -> None:
        self._clear_current_prompt_approval_request(request_id)
        self._pending_approval_requests = deque(
            r for r in self._pending_approval_requests if r.id != request_id
        )

    def _clear_current_prompt_approval_request(self, request_id: str) -> None:
        if (
            self._current_prompt_approval_request is not None
            and self._current_prompt_approval_request.id == request_id
        ):
            self._current_prompt_approval_request = None

    def _maybe_present_pending_approvals(self) -> None:
        if self._prompt_session is not None:
            self._activate_prompt_approval_modal()
            return
        if self._active_approval_sink is not None:
            while self._pending_approval_requests:
                request = self._pending_approval_requests.popleft()

                if not isinstance(self.soul, KimiSoul):
                    break
                if self.soul.runtime.approval_runtime is None:
                    break
                record = self.soul.runtime.approval_runtime.get_request(request.id)
                if record is None or record.status != "pending":
                    continue
                self._forward_approval_to_sink(request)

    def _get_default_buffer_text_and_cursor(self) -> tuple[str, int]:
        if self._prompt_session is None:
            return "", 0
        buf = self._prompt_session._session.default_buffer  # pyright: ignore[reportPrivateUsage]
        return buf.text, buf.cursor_position

    def _activate_prompt_approval_modal(self) -> None:
        if self._prompt_session is None:
            return
        current_request = self._current_prompt_approval_request
        if current_request is None:
            current_request = self._pop_next_pending_approval_request()
            self._current_prompt_approval_request = current_request
        if current_request is None:
            if self._approval_modal is not None:
                self._prompt_session.detach_modal(self._approval_modal)
                self._approval_modal = None
            return
        if self._approval_modal is None:
            self._approval_modal = ApprovalPromptDelegate(
                current_request,
                on_response=self._handle_prompt_approval_response,
                buffer_state_provider=self._get_default_buffer_text_and_cursor,
                text_expander=self._prompt_session._get_placeholder_manager().serialize_for_history,  # pyright: ignore[reportPrivateUsage]
            )
            self._prompt_session.attach_modal(self._approval_modal)
        else:
            if self._approval_modal.request.id != current_request.id:
                self._approval_modal.set_request(current_request)
        self._prompt_session.invalidate()

    def _handle_prompt_approval_response(
        self,
        request: ApprovalRequest,
        response: ApprovalResponse.Kind,
        feedback: str = "",
    ) -> None:
        if not isinstance(self.soul, KimiSoul):
            return
        if self.soul.runtime.approval_runtime is None:
            return
        self.soul.runtime.approval_runtime.resolve(request.id, response, feedback=feedback)
        self._clear_current_prompt_approval_request(request.id)
        self._activate_prompt_approval_modal()

    def _pop_next_pending_approval_request(self) -> ApprovalRequest | None:
        if not isinstance(self.soul, KimiSoul) or self.soul.runtime.approval_runtime is None:
            return None
        while self._pending_approval_requests:
            request = self._pending_approval_requests.popleft()

            record = self.soul.runtime.approval_runtime.get_request(request.id)
            if record is None or record.status != "pending":
                continue
            return request
        return None

    async def _auto_update(self) -> None:
        result = await do_update(print=False, check_only=True)
        if result == UpdateResult.UPDATED:
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

    def _cancel_background_tasks(self) -> None:
        """Cancel all background tasks (notification watcher, auto-update, etc.)."""
        for task in self._background_tasks:
            task.cancel()
        self._background_tasks.clear()


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
    head = Text.from_markup("Welcome to Kimi Code CLI!")
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
        from kimi_cli.ui.shell.update import SKIPPED_VERSION_FILE
        from kimi_cli.utils.envvar import get_env_bool

        if not get_env_bool("KIMI_CLI_NO_AUTO_UPDATE"):
            try:
                latest_version = LATEST_VERSION_FILE.read_text(encoding="utf-8").strip()
            except OSError:
                latest_version = ""
            if latest_version and semver_tuple(latest_version) > semver_tuple(current_version):
                try:
                    skipped = (
                        SKIPPED_VERSION_FILE.read_text(encoding="utf-8").strip()
                        if SKIPPED_VERSION_FILE.exists()
                        else ""
                    )
                except OSError:
                    skipped = ""
                if skipped != latest_version:
                    rows.append(
                        Text.from_markup(
                            f"\n[yellow]New version available: {latest_version}. "
                            f"Please run `{_update_mod.UPGRADE_COMMAND}` to upgrade.[/yellow]"
                        )
                    )
                    from kimi_cli.telemetry import track

                    track("update_prompted", current=current_version, latest=latest_version)

    console.print(
        Panel(
            Group(*rows),
            border_style=_KIMI_BLUE,
            expand=False,
            padding=(1, 2),
        )
    )
