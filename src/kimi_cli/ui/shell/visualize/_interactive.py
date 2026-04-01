"""Interactive prompt view for the bottom dynamic area.

``_PromptLiveView`` extends ``_LiveView`` with prompt_toolkit integration:
input routing (queue/steer/btw), modal management, and key handling.
"""

# pyright: reportPrivateUsage=false, reportUnusedClass=false

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import suppress

from kosong.message import Message
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
        self._pending_local_steer_keys: deque[str] = deque()
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

        # Clear the input buffer so the /btw command text doesn't
        # reappear when the modal is dismissed.
        buf = self._prompt_session._session.default_buffer  # pyright: ignore[reportPrivateUsage]
        if buf.text:
            buf.set_document(Document(), bypass_readonly=True)
        modal = _BtwModalDelegate(on_dismiss=self._dismiss_btw)
        modal._question = question  # pyright: ignore[reportPrivateUsage]
        modal.set_start_time(time.monotonic())
        self._btw_modal = modal
        self._prompt_session.attach_modal(modal)
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

    # -- Visualize loop ------------------------------------------------------

    async def visualize_loop(self, wire: WireUISide):
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

            # Wire closed — if btw modal is showing a result, keep the loop
            # alive so the user can read and dismiss it.
            if self._btw_modal is not None and not self._btw_modal._is_loading:  # pyright: ignore[reportPrivateUsage]
                self._btw_dismiss_event = asyncio.Event()
                await self._btw_dismiss_event.wait()
        finally:
            self._external_messages.shutdown(immediate=True)
            for task in (locals().get("wire_task"), locals().get("external_task")):
                if task is None:
                    continue
                task.cancel()
                with suppress(asyncio.CancelledError, QueueShutDown):
                    await task
            self._pending_local_steer_keys.clear()
            self._dismiss_btw()
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
        action = classify_input(user_input.command, is_streaming=True)
        match action.kind:
            case InputAction.BTW:
                if self._btw_runner is not None and not self._btw_active:
                    self._start_btw(action.args)
            case InputAction.QUEUE:
                self._queued_messages.append(user_input)
                self._flush_prompt_refresh()
            case InputAction.IGNORED:
                from kimi_cli.ui.shell.prompt import toast

                toast(action.args, topic="input-ignored", duration=3.0)
            case _:
                pass  # SEND and unknown actions are no-ops during streaming

    def handle_immediate_steer(self, user_input: UserInput) -> None:
        """Ctrl+S: inject immediately into the running turn's context."""
        if not user_input or self._turn_ended:
            return
        # Intercept /btw even on Ctrl+S — it should always run locally
        action = classify_input(user_input.command, is_streaming=True)
        if action.kind == InputAction.BTW:
            if self._btw_runner is not None and not self._btw_active:
                self._start_btw(action.args)
            return
        # Print permanently in conversation flow
        console.print(render_user_echo_text(user_input.command))
        # Store the command text as dedup key (type-safe string comparison)
        self._pending_local_steer_keys.append(user_input.command)
        self._steer(user_input.content)
        self._flush_prompt_refresh()

    # -- Wire event dispatch -------------------------------------------------

    def dispatch_wire_message(self, msg: WireMessage) -> None:
        # Dedup locally-originated steers: compare by text to avoid
        # type mismatches (list[ContentPart] vs str).
        if isinstance(msg, SteerInput) and self._pending_local_steer_keys:
            wire_text = (
                msg.user_input
                if isinstance(msg.user_input, str)
                else Message(role="user", content=msg.user_input).extract_text(" ")
            )
            if self._pending_local_steer_keys[0] == wire_text.strip():
                self._pending_local_steer_keys.popleft()
                return
        # Suppress parent's BtwBegin/BtwEnd spinner — btw is handled via modal
        if isinstance(msg, (BtwBegin, BtwEnd)):
            self._btw_spinner = None
            return
        super().dispatch_wire_message(msg)

    # -- Running prompt rendering --------------------------------------------

    def render_agent_status(self, columns: int) -> ANSI:
        """Render agent streaming output — always visible regardless of modal.

        This includes spinners (thinking/composing/compacting), content blocks,
        tool calls, approval/question panels, notifications.
        """
        if self._turn_ended:
            return ANSI("")
        body = render_to_ansi(self.compose(include_status=False), columns=columns).rstrip("\n")
        return ANSI(body if body else "")

    def render_running_prompt_body(self, columns: int) -> ANSI:
        """Render the interactive part — queued messages."""
        if not self._queued_messages:
            return ANSI("")

        blocks: list[RenderableType] = []
        for qi in self._queued_messages:
            blocks.append(Text(f"❯ {qi.command}", style="dim cyan"))
        blocks.append(Text("Press ↑ to edit queued messages", style="dim"))

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
        # ↑ on empty buffer: recall last queued message
        if key == "up" and self._queued_messages:
            return True
        # Ctrl+S: immediate steer
        return key == "c-s"

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        if key == "c-e":
            event.app.create_background_task(self._show_panel_in_pager())
            return

        # ↑ on empty buffer: pop last queued message back to input for editing
        if key == "up" and self._queued_messages:
            buf = event.current_buffer
            if not buf.text.strip():
                recalled = self._queued_messages.pop()
                buf.document = Document(recalled.command, len(recalled.command))
                self._flush_prompt_refresh()
                return

        # Ctrl+S: send current input as immediate steer (with placeholder resolution)
        if key == "c-s":
            buf = event.current_buffer
            text = buf.text.strip()
            if text:
                # Use _build_user_input to properly resolve placeholders
                # (e.g. [Pasted text #1 +3 lines] → actual content)
                steer_input = self._prompt_session._build_user_input(text)  # pyright: ignore[reportPrivateUsage]
                self._clear_buffer(buf)
                self.handle_immediate_steer(steer_input)
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
