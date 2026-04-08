"""Interactive prompt view for the bottom dynamic area.

``_PromptLiveView`` extends ``_LiveView`` with prompt_toolkit integration:
input routing (queue/steer/btw), modal management, and key handling.
"""

# pyright: reportPrivateUsage=false, reportUnusedClass=false

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress

from prompt_toolkit.application.run_in_terminal import run_in_terminal
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyPressEvent
from rich.console import Group, RenderableType
from rich.text import Text

from kimi_cli.ui.shell.console import console, render_to_ansi
from kimi_cli.ui.shell.echo import render_user_echo_text
from kimi_cli.ui.shell.keyboard import KeyEvent
from kimi_cli.ui.shell.prompt import (
    CustomPromptSession,
    UserInput,
)
from kimi_cli.ui.shell.visualize._btw_panel import _BtwModalDelegate
from kimi_cli.ui.shell.visualize._input_router import InputAction, classify_input
from kimi_cli.ui.shell.visualize._live_view import _LiveView
from kimi_cli.ui.shell.visualize._question_panel import (
    QuestionPromptDelegate,
    QuestionRequestPanel,
)
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import WireUISide
from kimi_cli.wire.types import (
    BtwBegin,
    BtwEnd,
    ContentPart,
    StatusUpdate,
    SteerInput,
    StepInterrupted,
    TurnEnd,
    WireMessage,
)

BtwRunner = Callable[[str, Callable[[str], None] | None], Awaitable[tuple[str | None, str | None]]]
"""async (question, on_text_chunk) -> (response, error). Used for direct btw execution."""


class _PromptLiveView(_LiveView):
    """Interactive prompt view: renders agent output above the input buffer.

    Supports two modes for user input during streaming:
    - **Queue (Enter)**: message is held and sent as a new turn after the
      current turn completes.  Queued messages are shown above the input and
      can be recalled with ↑.
    - **Steer (Ctrl+S)**: message is injected immediately into the running
      turn's context.  Shown permanently in the conversation flow.
    """

    modal_priority = 0

    def __init__(
        self,
        initial_status: StatusUpdate,
        *,
        prompt_session: CustomPromptSession,
        steer: Callable[[str | list[ContentPart]], None],
        btw_runner: BtwRunner | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> None:
        super().__init__(initial_status, cancel_event)
        self._prompt_session = prompt_session
        self._steer = steer
        self._btw_runner = btw_runner
        self._pending_local_steer_count: int = 0
        self._turn_ended = False
        self._question_modal: QuestionPromptDelegate | None = None
        # -- Queue: messages waiting to be sent after the turn ends ----------
        self._queued_messages: list[UserInput] = []
        # -- BTW modal (replaces prompt line when active) --------------------
        self._btw_modal: _BtwModalDelegate | None = None
        self._btw_dismiss_event: asyncio.Event | None = None
        self._btw_refresh_task: asyncio.Task[None] | None = None
        self._btw_run_task: asyncio.Task[None] | None = None

    # -- Helpers -------------------------------------------------------------

    @property
    def _btw_active(self) -> bool:
        return self._btw_modal is not None

    def _dismiss_btw(self) -> None:
        if self._btw_modal is not None:
            self._prompt_session.detach_modal(self._btw_modal)
            self._btw_modal = None
        if self._btw_run_task is not None:
            self._btw_run_task.cancel()
            self._btw_run_task = None
        if self._btw_refresh_task is not None:
            self._btw_refresh_task.cancel()
            self._btw_refresh_task = None
        # Wake the visualize_loop if it's waiting for user dismiss
        if self._btw_dismiss_event is not None:
            self._btw_dismiss_event.set()
            self._btw_dismiss_event = None
        self._prompt_session.invalidate()

    def _start_btw(self, question: str) -> None:
        """Set up the btw modal and start the LLM task."""
        import time

        # Attach modal FIRST (hides input buffer), then clear buffer.
        # This avoids a render frame between clear and attach where the
        # user would see an empty input flash.
        modal = _BtwModalDelegate(on_dismiss=self._dismiss_btw)
        modal._question = question  # pyright: ignore[reportPrivateUsage]
        modal.set_start_time(time.monotonic())
        self._btw_modal = modal
        self._prompt_session.attach_modal(modal)
        # Now safe to clear — buffer is hidden by modal
        buf = self._prompt_session._session.default_buffer  # pyright: ignore[reportPrivateUsage]
        if buf.text:
            buf.set_document(Document(), bypass_readonly=True)
        self._btw_refresh_task = asyncio.create_task(self._btw_refresh_loop())
        self._btw_run_task = asyncio.create_task(self._run_btw(question))

    async def _run_btw(self, question: str) -> None:
        """Execute /btw directly via btw_runner (no wire)."""
        assert self._btw_runner is not None
        try:

            def _on_chunk(chunk: str) -> None:
                if self._btw_modal is not None:
                    self._btw_modal.append_text(chunk)

            response, error = await self._btw_runner(question, _on_chunk)
            if self._btw_modal is not None:
                self._btw_modal.set_result(response, error)
        except asyncio.CancelledError:
            pass  # dismiss cancelled us — expected
        except Exception as e:
            if self._btw_modal is not None:
                self._btw_modal.set_result(None, str(e))
        finally:
            self._btw_run_task = None  # self-clear so _dismiss_btw won't cancel a done task
            if self._btw_refresh_task is not None:
                self._btw_refresh_task.cancel()
                self._btw_refresh_task = None
            self._prompt_session.invalidate()

    async def _btw_refresh_loop(self) -> None:
        """Periodically invalidate prompt so the spinner animates."""
        try:
            while True:
                await asyncio.sleep(0.08)
                self._prompt_session.invalidate()
        except asyncio.CancelledError:
            pass

    # -- Public API: queued messages for the shell to drain ------------------

    def drain_queued_messages(self) -> list[UserInput]:
        """Return and clear all queued messages (called by shell after turn)."""
        msgs = list(self._queued_messages)
        self._queued_messages.clear()
        return msgs

    async def wait_for_btw_dismiss(self) -> None:
        """Wait for btw LLM completion + user dismiss, then clean up.

        Called by the shell AFTER visualize_loop returns (which must exit
        within run_soul's 0.5s ui_task timeout).  The modal is still
        attached to prompt_session, so prompt_toolkit continues to render
        and handle key events.
        """
        if self._btw_modal is None:
            return
        # If LLM is still running, wait for it (user can Escape to cancel)
        if self._btw_run_task is not None and not self._btw_run_task.done():
            with suppress(asyncio.CancelledError):
                await self._btw_run_task
        # Wait for user dismiss (Escape/Enter/Space)
        if self._btw_modal is not None:  # pyright: ignore[reportUnnecessaryComparison]
            self._btw_dismiss_event = asyncio.Event()
            await self._btw_dismiss_event.wait()
        # Clean up: detach modal, cancel remaining tasks
        self._dismiss_btw()

    # -- Visualize loop ------------------------------------------------------

    async def visualize_loop(self, wire: WireUISide):
        # Declare outside try so finally can always cancel them.
        wire_task: asyncio.Task[WireMessage] | None = None
        external_task: asyncio.Task[WireMessage] | None = None
        try:
            wire_task = asyncio.create_task(wire.receive())
            external_task = asyncio.create_task(self._external_messages.get())
            while True:
                try:
                    done, _ = await asyncio.wait(
                        [wire_task, external_task],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if wire_task in done:
                        msg = wire_task.result()
                        wire_task = asyncio.create_task(wire.receive())
                    else:
                        msg = external_task.result()
                        external_task = asyncio.create_task(self._external_messages.get())
                except QueueShutDown:
                    msg, external_task = await self._drain_external_message_after_wire_shutdown(
                        external_task
                    )
                    if msg is not None:
                        self.dispatch_wire_message(msg)
                        self._flush_prompt_refresh()
                        continue
                    self.cleanup(is_interrupt=False)
                    self._flush_prompt_refresh()
                    break

                if isinstance(msg, StepInterrupted):
                    self.cleanup(is_interrupt=True)
                    self._flush_prompt_refresh()
                    break

                if isinstance(msg, TurnEnd):
                    self._turn_ended = True
                    self._flush_prompt_refresh()
                    continue

                self.dispatch_wire_message(msg)
                self._flush_prompt_refresh()

            # NOTE: btw dismiss waiting is handled by the shell layer
            # (run_soul_command → wait_for_btw_dismiss) AFTER visualize_loop
            # returns, because run_soul gives ui_task only a 0.5s timeout.
        finally:
            self._external_messages.shutdown(immediate=True)
            for task in (wire_task, external_task):
                if task is None:
                    continue
                task.cancel()
                with suppress(asyncio.CancelledError, QueueShutDown):
                    await task
            self._pending_local_steer_count = 0
            # Do NOT dismiss btw here — the shell will call
            # wait_for_btw_dismiss() after visualize_loop returns.
            # Only cancel the refresh task (spinner animation stops,
            # but modal stays attached for rendering + key handling).
            if self._btw_refresh_task is not None:
                self._btw_refresh_task.cancel()
                self._btw_refresh_task = None
            self._turn_ended = False
            if self._question_modal is not None:
                self._prompt_session.detach_modal(self._question_modal)
                self._question_modal = None
            self._prompt_session.invalidate()

    # -- Input handling ------------------------------------------------------

    def handle_local_input(self, user_input: UserInput) -> None:
        """Route user input through the unified classifier."""
        if not user_input or self._turn_ended:
            return
        action = classify_input(user_input.resolved_command, is_streaming=True)
        match action.kind:
            case InputAction.BTW:
                if self._btw_runner is not None and not self._btw_active:
                    self._start_btw(action.args)
            case InputAction.QUEUE:
                # Block shell-only commands from being queued — they would
                # be misrouted through run_soul() instead of the shell dispatcher.
                from kimi_cli.utils.slashcmd import parse_slash_command_call

                if cmd := parse_slash_command_call(user_input.resolved_command.strip()):
                    from kimi_cli.ui.shell.slash import registry as shell_registry

                    if shell_registry.find_command(cmd.name) is not None:
                        from kimi_cli.ui.shell.prompt import toast

                        toast(
                            f"/{cmd.name} is not available during streaming",
                            topic="input-ignored",
                            duration=3.0,
                        )
                        return
                self._queued_messages.append(user_input)
                # Invalidate directly — _flush_prompt_refresh() is gated by
                # _need_recompose which may be False between wire events.
                self._prompt_session.invalidate()
            case InputAction.IGNORED:
                from kimi_cli.ui.shell.prompt import toast

                toast(action.args, topic="input-ignored", duration=3.0)
            case _:
                pass  # SEND and unknown actions are no-ops during streaming

    def handle_immediate_steer(self, user_input: UserInput) -> None:
        """Ctrl+S: inject immediately into the running turn's context."""
        if not user_input or self._turn_ended:
            return
        # Intercept /btw and IGNORED (e.g. /btw without args) on Ctrl+S
        action = classify_input(user_input.resolved_command, is_streaming=True)
        if action.kind == InputAction.BTW:
            if self._btw_runner is not None and not self._btw_active:
                self._start_btw(action.args)
            return
        if action.kind == InputAction.IGNORED:
            from kimi_cli.ui.shell.prompt import toast

            toast(action.args, topic="input-ignored", duration=3.0)
            return
        # Block shell-only commands — same check as the Enter/queue path
        from kimi_cli.utils.slashcmd import parse_slash_command_call

        if cmd := parse_slash_command_call(user_input.resolved_command.strip()):
            from kimi_cli.ui.shell.slash import registry as shell_registry

            if shell_registry.find_command(cmd.name) is not None:
                from kimi_cli.ui.shell.prompt import toast

                toast(
                    f"/{cmd.name} is not available during streaming",
                    topic="input-ignored",
                    duration=3.0,
                )
                return
        # Print permanently in conversation flow (shows placeholder for pasted text)
        console.print(render_user_echo_text(user_input.command))
        # Track that we originated this steer locally (FIFO counter for dedup)
        self._pending_local_steer_count += 1
        self._steer(user_input.content)
        self._flush_prompt_refresh()

    # -- Wire event dispatch -------------------------------------------------

    def dispatch_wire_message(self, msg: WireMessage) -> None:
        # Dedup locally-originated steers: we know how many we sent,
        # so consume the matching SteerInput events without content comparison.
        # This avoids text vs media mismatch issues.
        if isinstance(msg, SteerInput) and self._pending_local_steer_count > 0:
            self._pending_local_steer_count -= 1
            return
        # Suppress parent's BtwBegin/BtwEnd spinner — btw is handled via modal
        if isinstance(msg, (BtwBegin, BtwEnd)):
            self._btw_spinner = None
            return
        super().dispatch_wire_message(msg)

    # -- Running prompt rendering --------------------------------------------

    def render_agent_status(self, columns: int) -> ANSI:
        """Render agent streaming output — always visible regardless of modal.

        Uses ``compose_agent_output()`` (not ``compose()``) to avoid rendering
        approval/question panels here.  Those panels are rendered by their
        respective modal delegates in Layer 2.
        """
        if self._turn_ended:
            return ANSI("")
        blocks = self.compose_agent_output()
        if not blocks:
            return ANSI("")
        body = render_to_ansi(Group(*blocks), columns=columns).rstrip("\n")
        return ANSI(body if body else "")

    def render_running_prompt_body(self, columns: int) -> ANSI:
        """Render the interactive part — queued messages."""
        if not self._queued_messages:
            return ANSI("")

        blocks: list[RenderableType] = []
        for qi in self._queued_messages:
            blocks.append(Text(f"❯ {qi.command}", style="dim cyan"))
        blocks.append(Text("↑ to edit · ctrl-s to send immediately", style="dim"))

        body = render_to_ansi(Group(*blocks), columns=columns).rstrip("\n")
        return ANSI(body if body else "")

    def running_prompt_placeholder(self) -> str | None:
        if self._current_approval_request_panel is not None:
            return "Use ↑/↓ or 1/2/3, then press Enter to respond to the approval request."
        return None

    def running_prompt_hides_input_buffer(self) -> bool:
        return False

    def running_prompt_allows_text_input(self) -> bool:
        if self._current_approval_request_panel is not None:
            return False
        if self._current_question_panel is not None:
            return False
        return not self._turn_ended

    def running_prompt_accepts_submission(self) -> bool:
        if self._current_approval_request_panel is not None:
            return True
        if self._current_question_panel is not None:
            return True
        return not self._turn_ended

    # -- Key handling --------------------------------------------------------

    def should_handle_running_prompt_key(self, key: str) -> bool:
        if key == "c-e":
            return self.has_expandable_panel()
        if self._current_approval_request_panel is not None:
            return key in {"up", "down", "enter", "1", "2", "3", "4"}
        if self._turn_ended:
            return False
        if key == "escape":
            return self._cancel_event is not None
        # ↑ on empty buffer: recall last queued message.
        # Only intercept when buffer is empty — otherwise let prompt_toolkit
        # handle ↑ for cursor movement / history navigation.
        if key == "up" and self._queued_messages:
            buf = self._prompt_session._session.default_buffer  # pyright: ignore[reportPrivateUsage]
            return not buf.text.strip()
        # Ctrl+S: immediate steer
        return key == "c-s"

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        if key == "c-e":
            event.app.create_background_task(self._show_panel_in_pager())
            return

        # ↑ on empty buffer: pop last queued message back to input for editing.
        # should_handle already verified buffer is empty.
        if key == "up" and self._queued_messages:
            buf = event.current_buffer
            recalled = self._queued_messages.pop()
            buf.document = Document(recalled.command, len(recalled.command))
            self._prompt_session.invalidate()
            return

        # Ctrl+S: immediate steer
        #   1) If input has text → steer it
        #   2) Else if queue has messages → pop first (oldest) and steer it
        if key == "c-s":
            buf = event.current_buffer
            text = buf.text.strip()
            if text:
                steer_input = self._prompt_session._build_user_input(text)  # pyright: ignore[reportPrivateUsage]
                self._clear_buffer(buf)
                self.handle_immediate_steer(steer_input)
            elif self._queued_messages:
                queued = self._queued_messages.pop(0)  # FIFO: oldest first
                self.handle_immediate_steer(queued)
                self._flush_prompt_refresh()
            return

        mapped = {
            "up": KeyEvent.UP,
            "down": KeyEvent.DOWN,
            "enter": KeyEvent.ENTER,
            "escape": KeyEvent.ESCAPE,
            "1": KeyEvent.NUM_1,
            "2": KeyEvent.NUM_2,
            "3": KeyEvent.NUM_3,
            "4": KeyEvent.NUM_4,
        }.get(key)
        if mapped is None:
            return
        if self._current_approval_request_panel is not None:
            self._clear_buffer(event.current_buffer)
        self.dispatch_keyboard_event(mapped)
        self._flush_prompt_refresh()

    async def _show_panel_in_pager(self) -> None:
        await run_in_terminal(self._show_expandable_panel_content)
        self._prompt_session.invalidate()

    @staticmethod
    def _clear_buffer(buffer: Buffer) -> None:
        if buffer.text:
            buffer.document = Document(text="", cursor_position=0)

    def _flush_prompt_refresh(self) -> None:
        if self._need_recompose:
            self._prompt_session.invalidate()
            self._need_recompose = False

    def cleanup(self, is_interrupt: bool) -> None:
        super().cleanup(is_interrupt)

    def _on_question_panel_state_changed(self) -> None:
        panel = self._current_question_panel
        if panel is None:
            if self._question_modal is not None:
                self._prompt_session.detach_modal(self._question_modal)
                self._question_modal = None
            return
        if self._question_modal is None:
            self._question_modal = QuestionPromptDelegate(
                panel,
                on_advance=self._advance_question,
                on_invalidate=self._flush_prompt_refresh,
                buffer_text_provider=lambda: self._prompt_session._session.default_buffer.text,  # pyright: ignore[reportPrivateUsage]
                text_expander=self._prompt_session._get_placeholder_manager().serialize_for_history,  # pyright: ignore[reportPrivateUsage]
            )
            self._prompt_session.attach_modal(self._question_modal)
        else:
            self._question_modal.set_panel(panel)
        self._prompt_session.invalidate()

    def _advance_question(self) -> QuestionRequestPanel | None:
        """Advance to the next question in the queue, returning the new panel or None."""
        self.show_next_question_request()
        return self._current_question_panel
