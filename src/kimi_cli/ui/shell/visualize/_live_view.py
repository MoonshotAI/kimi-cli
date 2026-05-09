# pyright: reportPrivateUsage=false, reportUnusedClass=false
"""Base event-consuming view for the streaming agent (Rich Live mode).

``_LiveView`` consumes wire events, updates internal state (content blocks,
tool calls, spinners, approval/question queues), and composes them into a
Rich renderable via ``compose()``.  The Rich ``Live`` context drives refresh.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress

from kosong.message import Message
from kosong.tooling import ToolError, ToolOk
from rich.console import Group, RenderableType
from rich.live import Live
from rich.markup import escape as rich_escape
from rich.panel import Panel
from rich.spinner import Spinner
from rich.text import Text

from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.echo import render_user_echo
from kimi_cli.ui.shell.keyboard import KeyboardListener, KeyEvent
from kimi_cli.ui.shell.visualize._approval_panel import (
    ApprovalRequestPanel,
    show_approval_in_pager,
)
from kimi_cli.ui.shell.visualize._blocks import (
    Markdown,
    _ContentBlock,
    _NotificationBlock,
    _StatusBlock,
    _ToolCallBlock,
)
from kimi_cli.ui.shell.visualize._question_panel import (
    QuestionRequestPanel,
    prompt_other_input,
    show_question_body_in_pager,
)
from kimi_cli.utils.aioqueue import Queue, QueueShutDown
from kimi_cli.utils.datetime import format_elapsed
from kimi_cli.utils.logging import logger
from kimi_cli.wire import WireUISide
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BtwBegin,
    BtwEnd,
    CompactionBegin,
    CompactionEnd,
    ContentPart,
    MCPLoadingBegin,
    MCPLoadingEnd,
    Notification,
    PlanDisplay,
    QuestionRequest,
    StatusUpdate,
    SteerInput,
    StepBegin,
    StepInterrupted,
    StepRetry,
    SubagentEvent,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
    ToolCallRequest,
    ToolResult,
    TurnBegin,
    TurnEnd,
    WireMessage,
)

MAX_LIVE_NOTIFICATIONS = 4
EXTERNAL_MESSAGE_GRACE_S = 0.1


def _format_step_retry(retry: StepRetry) -> Text:
    reason = _step_retry_reason(retry)
    wait = format_elapsed(retry.wait_s)
    return Text(
        f"Retrying after {reason} · attempt {retry.next_attempt}/{retry.max_attempts} · {wait}",
        style="grey50 italic",
    )


def _step_retry_reason(retry: StepRetry) -> str:
    if retry.status_code == 429:
        return "rate limit"
    if retry.status_code is not None and retry.status_code >= 500:
        return "server error"
    if retry.error_type == "APITimeoutError":
        return "timeout"
    if retry.error_type == "APIConnectionError":
        return "connection issue"
    if retry.error_type == "APIEmptyResponseError":
        return "empty response"
    return retry.error_type


@asynccontextmanager
async def _keyboard_listener(
    handler: Callable[[KeyboardListener, KeyEvent], Awaitable[None]],
):
    listener = KeyboardListener()
    await listener.start()

    async def _keyboard():
        while True:
            event = await listener.get()
            await handler(listener, event)

    task = asyncio.create_task(_keyboard())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await listener.stop()


class _LiveView:
    def __init__(
        self,
        initial_status: StatusUpdate,
        cancel_event: asyncio.Event | None = None,
        *,
        show_thinking_stream: bool = False,
    ):
        self._cancel_event = cancel_event
        self._show_thinking_stream = show_thinking_stream

        self._mooning_spinner = Spinner("moon", "")
        self._active_turn_depth = 0
        self._compacting_spinner: Spinner | None = None
        self._mcp_loading_spinner: Spinner | None = None
        self._btw_spinner: Spinner | None = None
        self._btw_question: str | None = None

        self._current_content_block: _ContentBlock | None = None
        self._tool_call_blocks: dict[str, _ToolCallBlock] = {}
        self._last_tool_call_block: _ToolCallBlock | None = None
        self._current_step_retry: StepRetry | None = None
        self._approval_request_queue = deque[ApprovalRequest]()
        """
        It is possible that multiple subagents request approvals at the same time,
        in which case we will have to queue them up and show them one by one.
        """
        self._current_approval_request_panel: ApprovalRequestPanel | None = None
        self._question_request_queue = deque[QuestionRequest]()
        self._current_question_panel: QuestionRequestPanel | None = None
        self._notification_blocks = deque[_NotificationBlock]()
        self._live_notification_blocks = deque[_NotificationBlock](maxlen=MAX_LIVE_NOTIFICATIONS)
        self._status_block = _StatusBlock(initial_status)

        self._need_recompose = False
        self._external_messages: Queue[WireMessage] = Queue()

    def _reset_live_shape(self, live: Live) -> None:
        # Rich doesn't expose a public API to clear Live's cached render height.
        # After leaving the pager, stale height causes cursor restores to jump,
        # so we reset the private _shape to re-anchor the next refresh.
        live._live_render._shape = None  # type: ignore[reportPrivateUsage]

    async def _drain_external_message_after_wire_shutdown(
        self,
        external_task: asyncio.Task[WireMessage],
    ) -> tuple[WireMessage | None, asyncio.Task[WireMessage]]:
        try:
            msg = await asyncio.wait_for(
                asyncio.shield(external_task),
                timeout=EXTERNAL_MESSAGE_GRACE_S,
            )
        except (TimeoutError, QueueShutDown):
            return None, external_task
        return msg, asyncio.create_task(self._external_messages.get())

    async def visualize_loop(self, wire: WireUISide):
        with Live(
            self.compose(),
            console=console,
            refresh_per_second=10,
            transient=True,
            vertical_overflow="visible",
        ) as live:

            async def keyboard_handler(listener: KeyboardListener, event: KeyEvent) -> None:
                # Handle Ctrl+E specially - pause Live while the pager is active
                if event == KeyEvent.CTRL_E:
                    if self.has_expandable_panel():
                        from kimi_cli.telemetry import track

                        track("shortcut_expand")
                        await listener.pause()
                        live.stop()
                        try:
                            self._show_expandable_panel_content()
                        finally:
                            # Reset live render shape so the next refresh re-anchors cleanly.
                            self._reset_live_shape(live)
                            live.start()
                            live.update(self.compose(), refresh=True)
                            await listener.resume()
                    return

                # Handle ENTER/SPACE on question panel when "Other" is selected
                if self._should_prompt_question_other_for_key(event):
                    panel = self._current_question_panel
                    assert panel is not None
                    question_text = panel.current_question_text
                    await listener.pause()
                    live.stop()
                    try:
                        text = await prompt_other_input(question_text)
                    finally:
                        self._reset_live_shape(live)
                        live.start()
                        await listener.resume()

                    self._submit_question_other_text(text)
                    live.update(self.compose(), refresh=True)
                    return

                self.dispatch_keyboard_event(event)
                if self._need_recompose:
                    live.update(self.compose(), refresh=True)
                    self._need_recompose = False

            async with _keyboard_listener(keyboard_handler):
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
                            if self._need_recompose:
                                live.update(self.compose(), refresh=True)
                                self._need_recompose = False
                            continue
                        self.cleanup(is_interrupt=False)
                        live.update(self.compose(), refresh=True)
                        break

                    if isinstance(msg, StepInterrupted):
                        self.cleanup(is_interrupt=True)
                        live.update(self.compose(), refresh=True)
                        break

                    self.dispatch_wire_message(msg)
                    if self._need_recompose:
                        live.update(self.compose(), refresh=True)
                        self._need_recompose = False
                wire_task.cancel()
                external_task.cancel()
                self._external_messages.shutdown(immediate=True)
                with suppress(asyncio.CancelledError, QueueShutDown):
                    await wire_task
                with suppress(asyncio.CancelledError, QueueShutDown):
                    await external_task

    def refresh_soon(self) -> None:
        self._need_recompose = True

    def _on_question_panel_state_changed(self) -> None:
        """Hook for subclasses to react when question panel visibility changes."""
        return None

    def enqueue_external_message(self, msg: WireMessage) -> None:
        try:
            self._external_messages.put_nowait(msg)
        except QueueShutDown:
            logger.debug("Ignoring external wire message after live view shutdown: {msg}", msg=msg)

    def has_expandable_panel(self) -> bool:
        return (
            self._expandable_approval_panel() is not None
            or self._expandable_question_panel() is not None
        )

    def _expandable_approval_panel(self) -> ApprovalRequestPanel | None:
        panel = self._current_approval_request_panel
        if panel is not None and panel.has_expandable_content:
            return panel
        return None

    def _expandable_question_panel(self) -> QuestionRequestPanel | None:
        panel = self._current_question_panel
        if panel is not None and panel.has_expandable_content:
            return panel
        return None

    def _show_expandable_panel_content(self) -> bool:
        if approval_panel := self._expandable_approval_panel():
            show_approval_in_pager(approval_panel)
            return True
        if question_panel := self._expandable_question_panel():
            show_question_body_in_pager(question_panel)
            return True
        return False

    def _should_prompt_question_other_for_key(self, key: KeyEvent) -> bool:
        panel = self._current_question_panel
        if panel is None or not panel.should_prompt_other_input():
            return False
        return key == KeyEvent.ENTER or (key == KeyEvent.SPACE and not panel.is_multi_select)

    def _submit_question_other_text(self, text: str) -> None:
        panel = self._current_question_panel
        if panel is None:
            return

        all_done = panel.submit_other(text)
        if all_done:
            panel.request.resolve(panel.get_answers())
            self.show_next_question_request()
        self.refresh_soon()

    # -- Composable rendering --------------------------------------------------

    def compose_interactive_panels(self) -> list[RenderableType]:
        """Approval and question panels — interactive overlays.

        In Non-interactive mode (Rich Live), these are rendered by ``compose()``.
        In Interactive mode (prompt_toolkit), these are rendered by modal
        delegates in Layer 2, so ``render_agent_status()`` skips them to
        avoid double-rendering.
        """
        blocks: list[RenderableType] = []
        if self._current_approval_request_panel:
            blocks.append(self._current_approval_request_panel.render())
        if self._current_question_panel:
            blocks.append(self._current_question_panel.render())
        return blocks

    def compose_agent_output(self) -> list[RenderableType]:
        """Spinners, content blocks, tool calls, notifications.

        Pure agent streaming status — no interactive overlays.
        Always safe to render regardless of modal state.

        Layout:
          - Modal (one of): MCP spinner | Compaction spinner | main group
          - Main group (additive): retry banner, content block, tool calls;
            falls back to the mooning spinner when all three are empty
            and a turn is active
          - btw spinner (prepended) and live notifications (appended) always show

        The retry banner never coexists with content/tool blocks at runtime;
        that is enforced upstream (discard_retry_attempt, append_content,
        append_tool_call), not by this function.
        """
        blocks: list[RenderableType] = []
        if self._btw_spinner is not None:
            blocks.append(self._btw_spinner)
        if self._mcp_loading_spinner is not None:
            blocks.append(self._mcp_loading_spinner)
        elif self._compacting_spinner is not None:
            blocks.append(self._compacting_spinner)
        else:
            has_main_content = False
            if self._current_step_retry is not None:
                blocks.append(_format_step_retry(self._current_step_retry))
                has_main_content = True
            if self._current_content_block is not None:
                blocks.append(self._current_content_block.compose())
                has_main_content = True
            for tool_call in list(self._tool_call_blocks.values()):
                blocks.append(tool_call.compose())
                has_main_content = True
            if not has_main_content and self._active_turn_depth > 0:
                blocks.append(self._mooning_spinner)
        for notification in list(self._live_notification_blocks):
            blocks.append(notification.compose())
        return blocks

    def compose(self, *, include_status: bool = True) -> RenderableType:
        """Compose the full live view display content.

        Combines interactive panels (approval/question) and agent output.
        Panels are rendered first so they remain visible at the top of the
        terminal even when tool-call output is long enough to push content
        beyond the visible area.

        In Interactive mode, prefer ``compose_agent_output()`` for Layer 1
        rendering to avoid double-rendering panels that modal delegates
        already handle in Layer 2.
        """
        blocks: list[RenderableType] = []
        blocks.extend(self.compose_interactive_panels())
        blocks.extend(self.compose_agent_output())
        if include_status:
            blocks.append(self._status_block.render())
        return Group(*blocks)

    def dispatch_wire_message(self, msg: WireMessage) -> None:
        """Dispatch the Wire message to UI components."""
        assert not isinstance(msg, StepInterrupted)  # handled in visualize_loop

        if isinstance(msg, StepBegin):
            self.cleanup(is_interrupt=False)
            self._mcp_loading_spinner = None
            # Defensive: if StepBegin arrives without a preceding TurnBegin
            # (e.g. during replay), ensure the turn is considered active.
            if self._active_turn_depth == 0:
                self._active_turn_depth = 1
            self.refresh_soon()
            return
        if isinstance(msg, StepRetry):
            self.discard_retry_attempt(msg)
            self.refresh_soon()
            return

        match msg:
            case TurnBegin():
                self._active_turn_depth += 1
                self.flush_content()
                self.refresh_soon()
            case SteerInput(user_input=user_input):
                self.cleanup(is_interrupt=False)
                content: list[ContentPart]
                if isinstance(user_input, list):
                    content = list(user_input)
                else:
                    content = [TextPart(text=user_input)]
                console.print(render_user_echo(Message(role="user", content=content)))
            case TurnEnd():
                self._active_turn_depth = max(0, self._active_turn_depth - 1)
            case CompactionBegin():
                self._compacting_spinner = Spinner("balloon", "Compacting...")
                self.refresh_soon()
            case CompactionEnd():
                self._compacting_spinner = None
                self.refresh_soon()
            case MCPLoadingBegin():
                self._mcp_loading_spinner = Spinner("dots", "Connecting to MCP servers...")
                self.refresh_soon()
            case MCPLoadingEnd():
                self._mcp_loading_spinner = None
                self.refresh_soon()
            case BtwBegin(question=question):
                truncated = (question[:40] + "...") if len(question) > 40 else question
                self._btw_question = question
                self._btw_spinner = Spinner("dots", f"Side question: {rich_escape(truncated)}")
                self.refresh_soon()
            case BtwEnd(response=response, error=error):
                self._btw_spinner = None
                q = self._btw_question or ""
                truncated_q = (q[:50] + "...") if len(q) > 50 else q
                self._btw_question = None
                if response:
                    console.print(
                        Panel(
                            Markdown(response),
                            title=f"[dim]btw: {rich_escape(truncated_q)}[/dim]",
                            border_style="grey50",
                            padding=(0, 1),
                        )
                    )
                elif error:
                    console.print(
                        Panel(
                            Text(error, style="red"),
                            title="[dim]btw (error)[/dim]",
                            border_style="red",
                            padding=(0, 1),
                        )
                    )
                self.refresh_soon()
            case StatusUpdate():
                self._status_block.update(msg)
            case Notification():
                self.append_notification(msg)
            case ContentPart():
                self.append_content(msg)
            case ToolCall():
                self.append_tool_call(msg)
            case ToolCallPart():
                self.append_tool_call_part(msg)
            case ToolResult():
                self.append_tool_result(msg)
            case ApprovalResponse():
                self._reconcile_approval_requests()
            case SubagentEvent():
                self.handle_subagent_event(msg)
            case PlanDisplay():
                self.display_plan(msg)
            case ApprovalRequest():
                self.request_approval(msg)
            case QuestionRequest():
                self.request_question(msg)
            case ToolCallRequest():
                logger.warning("Unexpected ToolCallRequest in shell UI: {msg}", msg=msg)
            case _:
                pass

    def discard_retry_attempt(self, retry: StepRetry) -> None:
        """Discard partial streamed state from a failed retry attempt.

        Only LLM-stream-related state is cleared: the in-progress content
        block and unfinished tool-call blocks, since these reflect the
        aborted attempt and would otherwise be re-rendered alongside the
        new attempt's output.

        Other state survives intentionally:
        - ``_status_block`` is only updated by ``StatusUpdate``, which is
          emitted on a successful step — never during a failed attempt.
        - Compaction / MCP-loading spinners are bracketed by their own
          begin/end events and are independent of the LLM stream.
        - Notifications and approval/question queues are user- or
          hook-driven and have no causal relationship to the retry.

        Note: content already flushed to terminal history (e.g. an earlier
        ``ThinkPart`` whose printing was triggered when the stream switched
        to a ``TextPart``) cannot be unprinted. The retry banner is shown
        as a live status line while the retry is pending and is replaced
        once the new attempt produces output, so it marks the boundary
        only transiently — flushed history from the failed attempt remains
        directly adjacent to the new attempt's output in scrollback.
        """
        self._current_content_block = None
        self._tool_call_blocks.clear()
        self._last_tool_call_block = None
        self._current_step_retry = retry

    def _try_submit_question(self, method: str = "enter") -> None:
        """Submit the current question answer; if all done, resolve and advance."""
        panel = self._current_question_panel
        if panel is None:
            return
        all_done = panel.submit()
        if all_done:
            from kimi_cli.telemetry import track

            track("question_answered", method=method)
            panel.request.resolve(panel.get_answers())
            self.show_next_question_request()

    def dispatch_keyboard_event(self, event: KeyEvent) -> None:
        # Handle question panel keyboard events
        if self._current_question_panel is not None:
            match event:
                case KeyEvent.UP:
                    self._current_question_panel.move_up()
                case KeyEvent.DOWN:
                    self._current_question_panel.move_down()
                case KeyEvent.LEFT:
                    self._current_question_panel.prev_tab()
                case KeyEvent.RIGHT | KeyEvent.TAB:
                    self._current_question_panel.next_tab()
                case KeyEvent.SPACE:
                    if self._current_question_panel.is_multi_select:
                        self._current_question_panel.toggle_select()
                    else:
                        self._try_submit_question(method="space")
                case KeyEvent.ENTER:
                    # "Other" is handled in keyboard_handler (async context)
                    self._try_submit_question(method="enter")
                case KeyEvent.ESCAPE:
                    from kimi_cli.telemetry import track

                    track("question_dismissed")
                    self._current_question_panel.request.resolve({})
                    self.show_next_question_request()
                case (
                    KeyEvent.NUM_1
                    | KeyEvent.NUM_2
                    | KeyEvent.NUM_3
                    | KeyEvent.NUM_4
                    | KeyEvent.NUM_5
                    | KeyEvent.NUM_6
                ):
                    # Number keys select option in question panel
                    num_map = {
                        KeyEvent.NUM_1: 0,
                        KeyEvent.NUM_2: 1,
                        KeyEvent.NUM_3: 2,
                        KeyEvent.NUM_4: 3,
                        KeyEvent.NUM_5: 4,
                        KeyEvent.NUM_6: 5,
                    }
                    idx = num_map[event]
                    panel = self._current_question_panel
                    if panel.select_index(idx):
                        if panel.is_multi_select:
                            panel.toggle_select()
                        elif not panel.is_other_selected:
                            # Auto-submit for single-select (unless "Other")
                            self._try_submit_question(method="number_key")
                case _:
                    pass
            self.refresh_soon()
            return

        # handle ESC key to cancel the run
        if event == KeyEvent.ESCAPE and self._cancel_event is not None:
            from kimi_cli.telemetry import track

            track("cancel")
            self._cancel_event.set()
            return

        # Handle approval panel keyboard events
        if self._current_approval_request_panel is not None:
            match event:
                case KeyEvent.UP:
                    self._current_approval_request_panel.move_up()
                    self.refresh_soon()
                case KeyEvent.DOWN:
                    self._current_approval_request_panel.move_down()
                    self.refresh_soon()
                case KeyEvent.ENTER:
                    self._submit_approval()
                case KeyEvent.NUM_1 | KeyEvent.NUM_2 | KeyEvent.NUM_3 | KeyEvent.NUM_4:
                    # Number keys directly select and submit approval option
                    num_map = {
                        KeyEvent.NUM_1: 0,
                        KeyEvent.NUM_2: 1,
                        KeyEvent.NUM_3: 2,
                        KeyEvent.NUM_4: 3,
                    }
                    idx = num_map[event]
                    if idx < len(self._current_approval_request_panel.options):
                        self._current_approval_request_panel.selected_index = idx
                        self._submit_approval()
                case _:
                    pass
            return

    def _submit_approval(self) -> None:
        """Submit the currently selected approval response."""
        assert self._current_approval_request_panel is not None
        request = self._current_approval_request_panel.request
        resp = self._current_approval_request_panel.get_selected_response()
        request.resolve(resp)
        if resp == "approve_for_session":
            to_remove_from_queue: list[ApprovalRequest] = []
            for request in self._approval_request_queue:
                # approve all queued requests with the same action
                if request.action == self._current_approval_request_panel.request.action:
                    request.resolve("approve_for_session")
                    to_remove_from_queue.append(request)
            for request in to_remove_from_queue:
                self._approval_request_queue.remove(request)
        self.show_next_approval_request()

    def cleanup(self, is_interrupt: bool) -> None:
        """Cleanup the live view on step end or interruption."""
        self.flush_content()

        for block in self._tool_call_blocks.values():
            if not block.finished:
                # this should not happen, but just in case
                block.finish(
                    ToolError(message="", brief="Interrupted")
                    if is_interrupt
                    else ToolOk(output="")
                )
        self._last_tool_call_block = None
        self.flush_finished_tool_calls()
        self.flush_notifications()

        # Clear transient spinners to prevent visual residuals after interrupts
        self._compacting_spinner = None
        self._mcp_loading_spinner = None
        self._btw_spinner = None
        self._current_step_retry = None

        if is_interrupt:
            self._active_turn_depth = 0

        while self._approval_request_queue:
            # should not happen, but just in case
            self._approval_request_queue.popleft().resolve("reject")
        self._current_approval_request_panel = None

        while self._question_request_queue:
            self._question_request_queue.popleft().resolve({})
        self._current_question_panel = None

    def flush_content(self) -> None:
        """Flush the current content block."""
        if self._current_content_block is not None:
            if self._current_content_block.has_pending():
                console.print(self._current_content_block.compose_final())
            self._current_content_block = None
            self.refresh_soon()

    def flush_finished_tool_calls(self) -> None:
        """Flush all leading finished tool call blocks."""
        tool_call_ids = list(self._tool_call_blocks.keys())
        for tool_call_id in tool_call_ids:
            block = self._tool_call_blocks[tool_call_id]
            if not block.finished:
                break

            self._tool_call_blocks.pop(tool_call_id)
            console.print(block.compose())
            if self._last_tool_call_block == block:
                self._last_tool_call_block = None
            self.refresh_soon()

    def flush_notifications(self) -> None:
        """Flush rendered notifications to terminal history."""
        self._live_notification_blocks.clear()
        while self._notification_blocks:
            console.print(self._notification_blocks.popleft().compose())
            self.refresh_soon()

    def append_content(self, part: ContentPart) -> None:
        match part:
            case ThinkPart(think=text) | TextPart(text=text):
                is_think = isinstance(part, ThinkPart)
                # Skip empty TextPart, but still create the block for empty
                # ThinkPart so the "Thinking" indicator shows immediately
                # (e.g. Anthropic/OpenAI block-start events yield think="").
                if not text and not is_think:
                    return
                self._current_step_retry = None
                if self._current_content_block is None:
                    self._current_content_block = _ContentBlock(
                        is_think, show_thinking_stream=self._show_thinking_stream
                    )
                    self.refresh_soon()
                elif self._current_content_block.is_think != is_think:
                    self.flush_content()
                    self._current_content_block = _ContentBlock(
                        is_think, show_thinking_stream=self._show_thinking_stream
                    )
                    self.refresh_soon()
                if text:
                    self._current_content_block.append(text)
                    self.refresh_soon()
            case _:
                # TODO: support more content part types
                pass

    def append_tool_call(self, tool_call: ToolCall) -> None:
        self._current_step_retry = None
        self.flush_content()
        self._tool_call_blocks[tool_call.id] = _ToolCallBlock(tool_call)
        self._last_tool_call_block = self._tool_call_blocks[tool_call.id]
        self.refresh_soon()

    def append_tool_call_part(self, part: ToolCallPart) -> None:
        if not part.arguments_part:
            return
        if self._last_tool_call_block is None:
            return
        self._last_tool_call_block.append_args_part(part.arguments_part)
        self.refresh_soon()

    def append_tool_result(self, result: ToolResult) -> None:
        if block := self._tool_call_blocks.get(result.tool_call_id):
            block.finish(result.return_value)
            self.flush_finished_tool_calls()
            self.refresh_soon()

    def append_notification(self, notification: Notification) -> None:
        block = _NotificationBlock(notification)
        self._notification_blocks.append(block)
        self._live_notification_blocks.append(block)
        self.refresh_soon()

    def request_approval(self, request: ApprovalRequest) -> None:
        self._approval_request_queue.append(request)

        if self._current_approval_request_panel is None:
            console.bell()
            self.show_next_approval_request()

    def _reconcile_approval_requests(self) -> None:
        self._approval_request_queue = deque(
            request for request in self._approval_request_queue if not request.resolved
        )
        if (
            self._current_approval_request_panel is not None
            and self._current_approval_request_panel.request.resolved
        ):
            self._current_approval_request_panel = None
            self.show_next_approval_request()
        else:
            self.refresh_soon()

    def show_next_approval_request(self) -> None:
        """
        Show the next approval request from the queue.
        If there are no pending requests, clear the current approval panel.
        """
        if not self._approval_request_queue:
            if self._current_approval_request_panel is not None:
                self._current_approval_request_panel = None
                self.refresh_soon()
            return

        while self._approval_request_queue:
            request = self._approval_request_queue.popleft()
            if request.resolved:
                # skip resolved requests
                continue
            self._current_approval_request_panel = ApprovalRequestPanel(request)
            self.refresh_soon()
            break
        else:
            # All queued requests were already resolved
            if self._current_approval_request_panel is not None:
                self._current_approval_request_panel = None
                self.refresh_soon()

    def display_plan(self, msg: PlanDisplay) -> None:
        """Render plan content inline in the chat with a bordered panel."""
        self.flush_content()
        self.flush_finished_tool_calls()
        plan_body = Markdown(msg.content)
        subtitle = Text(msg.file_path, style="dim")
        panel = Panel(
            plan_body,
            title="[bold cyan]Plan[/bold cyan]",
            title_align="left",
            subtitle=subtitle,
            subtitle_align="left",
            border_style="cyan",
            padding=(1, 2),
        )
        console.print(panel)

    def request_question(self, request: QuestionRequest) -> None:
        self._question_request_queue.append(request)
        if self._current_question_panel is None:
            console.bell()
            self.show_next_question_request()

    def show_next_question_request(self) -> None:
        """Show the next question request from the queue."""
        if not self._question_request_queue:
            if self._current_question_panel is not None:
                self._current_question_panel = None
                self.refresh_soon()
                self._on_question_panel_state_changed()
            return

        while self._question_request_queue:
            request = self._question_request_queue.popleft()
            if request.resolved:
                continue
            self._current_question_panel = QuestionRequestPanel(request)
            self.refresh_soon()
            self._on_question_panel_state_changed()
            break
        else:
            # All queued requests were already resolved
            if self._current_question_panel is not None:
                self._current_question_panel = None
                self.refresh_soon()
                self._on_question_panel_state_changed()

    def handle_subagent_event(self, event: SubagentEvent) -> None:
        if event.parent_tool_call_id is None:
            return
        block = self._tool_call_blocks.get(event.parent_tool_call_id)
        if block is None:
            return
        if event.agent_id is not None and event.subagent_type is not None:
            block.set_subagent_metadata(event.agent_id, event.subagent_type)

        match event.event:
            case ToolCall() as tool_call:
                block.append_sub_tool_call(tool_call)
            case ToolCallPart() as tool_call_part:
                block.append_sub_tool_call_part(tool_call_part)
            case ToolResult() as tool_result:
                block.finish_sub_tool_call(tool_result)
                self.refresh_soon()
            case _:
                # ignore other events for now
                # TODO: may need to handle multi-level nested subagents
                pass
