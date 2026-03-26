from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import Any, NamedTuple, cast

import streamingjson  # type: ignore[reportMissingTypeStubs]
from kosong.message import Message
from kosong.tooling import ToolError, ToolOk
from prompt_toolkit.application.run_in_terminal import run_in_terminal
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyPressEvent
from rich.console import Group, RenderableType
from rich.live import Live
from rich.spinner import Spinner
from rich.style import Style
from rich.text import Text

from kimi_cli.soul import format_context_status
from kimi_cli.tools import extract_key_argument
from kimi_cli.ui.shell.approval_panel import (
    ApprovalPromptDelegate as ApprovalPromptDelegate,  # noqa: F401 — re-exported
)
from kimi_cli.ui.shell.approval_panel import (
    ApprovalRequestPanel,
    show_approval_in_pager,
)
from kimi_cli.ui.shell.approval_panel import (
    render_approval_request_for_terminal as render_approval_request_for_terminal,  # noqa: F401 — re-exported
)
from kimi_cli.ui.shell.console import console, render_to_ansi
from kimi_cli.ui.shell.echo import render_user_echo, render_user_echo_text
from kimi_cli.ui.shell.keyboard import KeyboardListener, KeyEvent
from kimi_cli.ui.shell.prompt import (
    CustomPromptSession,
    UserInput,
)
from kimi_cli.ui.shell.question_panel import (
    QuestionPromptDelegate as QuestionPromptDelegate,  # noqa: F401 — re-exported
)
from kimi_cli.ui.shell.question_panel import (
    QuestionRequestPanel,
    prompt_other_input,
    show_question_body_in_pager,
)
from kimi_cli.utils.aioqueue import Queue, QueueShutDown
from kimi_cli.utils.logging import logger
from kimi_cli.utils.rich.columns import BulletColumns
from kimi_cli.utils.rich.markdown import Markdown
from kimi_cli.wire import WireUISide
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BackgroundTaskDisplayBlock,
    BriefDisplayBlock,
    CompactionBegin,
    CompactionEnd,
    ContentPart,
    MCPLoadingBegin,
    MCPLoadingEnd,
    Notification,
    QuestionRequest,
    StatusUpdate,
    SteerInput,
    StepBegin,
    StepInterrupted,
    SubagentEvent,
    TextPart,
    ThinkPart,
    TodoDisplayBlock,
    ToolCall,
    ToolCallPart,
    ToolCallRequest,
    ToolResult,
    ToolReturnValue,
    TurnBegin,
    TurnEnd,
    WireMessage,
)

MAX_SUBAGENT_TOOL_CALLS_TO_SHOW = 4
MAX_LIVE_NOTIFICATIONS = 4
EXTERNAL_MESSAGE_GRACE_S = 0.1


async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusUpdate,
    cancel_event: asyncio.Event | None = None,
    prompt_session: CustomPromptSession | None = None,
    steer: Callable[[str | list[ContentPart]], None] | None = None,
    bind_running_input: Callable[[Callable[[UserInput], None], Callable[[], None]], None]
    | None = None,
    unbind_running_input: Callable[[], None] | None = None,
    on_view_ready: Callable[[Any], None] | None = None,
    on_view_closed: Callable[[], None] | None = None,
):
    """
    A loop to consume agent events and visualize the agent behavior.

    Args:
        wire: Communication channel with the agent
        initial_status: Initial status snapshot
        cancel_event: Event that can be set (e.g., by ESC key) to cancel the run
    """
    if prompt_session is not None and steer is not None:
        view = _PromptLiveView(
            initial_status,
            prompt_session=prompt_session,
            steer=steer,
            cancel_event=cancel_event,
        )
        prompt_session.attach_running_prompt(view)

        def _cancel_running_input() -> None:
            if cancel_event is not None:
                cancel_event.set()

        if bind_running_input is not None:
            bind_running_input(view.handle_local_input, _cancel_running_input)
    else:
        view = _LiveView(initial_status, cancel_event)
    if on_view_ready is not None:
        on_view_ready(view)
    try:
        await view.visualize_loop(wire)
    finally:
        if prompt_session is not None and steer is not None:
            if unbind_running_input is not None:
                unbind_running_input()
            assert isinstance(view, _PromptLiveView)
            prompt_session.detach_running_prompt(view)
        if on_view_closed is not None:
            on_view_closed()


class _ContentBlock:
    def __init__(self, is_think: bool):
        self.is_think = is_think
        self._spinner = Spinner("dots", "Thinking..." if is_think else "Composing...")
        self.raw_text = ""

    def compose(self) -> RenderableType:
        if self.is_think and self.raw_text:
            return BulletColumns(
                Markdown(self.raw_text, style="grey50 italic"),
                bullet_style="grey50",
            )
        return self._spinner

    def compose_final(self) -> RenderableType:
        return BulletColumns(
            Markdown(
                self.raw_text,
                style="grey50 italic" if self.is_think else "",
            ),
            bullet_style="grey50" if self.is_think else None,
        )

    def append(self, content: str) -> None:
        self.raw_text += content


class _ToolCallBlock:
    class FinishedSubCall(NamedTuple):
        call: ToolCall
        result: ToolReturnValue

    def __init__(self, tool_call: ToolCall):
        self._tool_name = tool_call.function.name
        self._lexer = streamingjson.Lexer()
        if tool_call.function.arguments is not None:
            self._lexer.append_string(tool_call.function.arguments)

        self._argument = extract_key_argument(self._lexer, self._tool_name)
        self._full_url = self._extract_full_url(tool_call.function.arguments, self._tool_name)
        self._result: ToolReturnValue | None = None
        self._subagent_id: str | None = None
        self._subagent_type: str | None = None

        self._ongoing_subagent_tool_calls: dict[str, ToolCall] = {}
        self._last_subagent_tool_call: ToolCall | None = None
        self._n_finished_subagent_tool_calls = 0
        self._finished_subagent_tool_calls = deque[_ToolCallBlock.FinishedSubCall](
            maxlen=MAX_SUBAGENT_TOOL_CALLS_TO_SHOW
        )

        self._spinning_dots = Spinner("dots", text="")
        self._renderable: RenderableType = self._compose()

    def compose(self) -> RenderableType:
        return self._renderable

    @property
    def finished(self) -> bool:
        return self._result is not None

    def append_args_part(self, args_part: str):
        if self.finished:
            return
        self._lexer.append_string(args_part)
        # TODO: maybe don't extract detail if it's already stable
        argument = extract_key_argument(self._lexer, self._tool_name)
        if argument and argument != self._argument:
            self._argument = argument
            self._full_url = self._extract_full_url(self._lexer.complete_json(), self._tool_name)
            self._renderable = BulletColumns(
                self._build_headline_text(),
                bullet=self._spinning_dots,
            )

    def finish(self, result: ToolReturnValue):
        self._result = result
        self._renderable = self._compose()

    def append_sub_tool_call(self, tool_call: ToolCall):
        self._ongoing_subagent_tool_calls[tool_call.id] = tool_call
        self._last_subagent_tool_call = tool_call

    def append_sub_tool_call_part(self, tool_call_part: ToolCallPart):
        if self._last_subagent_tool_call is None:
            return
        if not tool_call_part.arguments_part:
            return
        if self._last_subagent_tool_call.function.arguments is None:
            self._last_subagent_tool_call.function.arguments = tool_call_part.arguments_part
        else:
            self._last_subagent_tool_call.function.arguments += tool_call_part.arguments_part

    def finish_sub_tool_call(self, tool_result: ToolResult):
        self._last_subagent_tool_call = None
        sub_tool_call = self._ongoing_subagent_tool_calls.pop(tool_result.tool_call_id, None)
        if sub_tool_call is None:
            return

        self._finished_subagent_tool_calls.append(
            _ToolCallBlock.FinishedSubCall(
                call=sub_tool_call,
                result=tool_result.return_value,
            )
        )
        self._n_finished_subagent_tool_calls += 1
        self._renderable = self._compose()

    def set_subagent_metadata(self, agent_id: str, subagent_type: str) -> None:
        changed = (self._subagent_id, self._subagent_type) != (agent_id, subagent_type)
        self._subagent_id = agent_id
        self._subagent_type = subagent_type
        if changed:
            self._renderable = self._compose()

    def _compose(self) -> RenderableType:
        lines: list[RenderableType] = [
            self._build_headline_text(),
        ]
        if self._subagent_id is not None and self._subagent_type is not None:
            lines.append(
                BulletColumns(
                    Text(
                        f"subagent {self._subagent_type} ({self._subagent_id})",
                        style="grey50",
                    ),
                    bullet_style="grey50",
                )
            )

        if self._n_finished_subagent_tool_calls > MAX_SUBAGENT_TOOL_CALLS_TO_SHOW:
            n_hidden = self._n_finished_subagent_tool_calls - MAX_SUBAGENT_TOOL_CALLS_TO_SHOW
            lines.append(
                BulletColumns(
                    Text(
                        f"{n_hidden} more tool call{'s' if n_hidden > 1 else ''} ...",
                        style="grey50 italic",
                    ),
                    bullet_style="grey50",
                )
            )
        for sub_call, sub_result in self._finished_subagent_tool_calls:
            argument = extract_key_argument(
                sub_call.function.arguments or "", sub_call.function.name
            )
            sub_url = self._extract_full_url(sub_call.function.arguments, sub_call.function.name)
            sub_text = Text()
            sub_text.append("Used ")
            sub_text.append(sub_call.function.name, style="blue")
            if argument:
                sub_text.append(" (", style="grey50")
                arg_style = Style(color="grey50", link=sub_url) if sub_url else "grey50"
                sub_text.append(argument, style=arg_style)
                sub_text.append(")", style="grey50")
            lines.append(
                BulletColumns(
                    sub_text,
                    bullet_style="green" if not sub_result.is_error else "red",
                )
            )

        if self._result is not None:
            for block in self._result.display:
                if isinstance(block, BriefDisplayBlock):
                    style = "grey50" if not self._result.is_error else "red"
                    if block.text:
                        lines.append(Markdown(block.text, style=style))
                elif isinstance(block, TodoDisplayBlock):
                    markdown = self._render_todo_markdown(block)
                    if markdown:
                        lines.append(Markdown(markdown, style="grey50"))
                elif isinstance(block, BackgroundTaskDisplayBlock):
                    lines.append(
                        Markdown(
                            (f"`{block.task_id}` [{block.status}] {block.description}"),
                            style="grey50",
                        )
                    )

        if self.finished:
            assert self._result is not None
            return BulletColumns(
                Group(*lines),
                bullet_style="green" if not self._result.is_error else "red",
            )
        else:
            return BulletColumns(
                Group(*lines),
                bullet=self._spinning_dots,
            )

    @staticmethod
    def _extract_full_url(arguments: str | None, tool_name: str) -> str | None:
        """Extract the full URL from FetchURL tool arguments."""
        if tool_name != "FetchURL" or not arguments:
            return None
        try:
            args = json.loads(arguments, strict=False)
        except (json.JSONDecodeError, TypeError):
            return None
        if isinstance(args, dict):
            url = cast(dict[str, Any], args).get("url")
            if url:
                return str(url)
        return None

    def _build_headline_text(self) -> Text:
        text = Text()
        text.append("Used " if self.finished else "Using ")
        text.append(self._tool_name, style="blue")
        if self._argument:
            text.append(" (", style="grey50")
            arg_style = Style(color="grey50", link=self._full_url) if self._full_url else "grey50"
            text.append(self._argument, style=arg_style)
            text.append(")", style="grey50")
        return text

    def _render_todo_markdown(self, block: TodoDisplayBlock) -> str:
        lines: list[str] = []
        for todo in block.items:
            normalized = todo.status.replace("_", " ").lower()
            match normalized:
                case "pending":
                    lines.append(f"- {todo.title}")
                case "in progress":
                    lines.append(f"- {todo.title} ←")
                case "done":
                    lines.append(f"- ~~{todo.title}~~")
                case _:
                    lines.append(f"- {todo.title}")
        return "\n".join(lines)


class _NotificationBlock:
    _SEVERITY_STYLE = {
        "info": "cyan",
        "success": "green",
        "warning": "yellow",
        "error": "red",
    }

    def __init__(self, notification: Notification):
        self.notification = notification

    def compose(self) -> RenderableType:
        style = self._SEVERITY_STYLE.get(self.notification.severity, "cyan")
        lines: list[RenderableType] = [Text(self.notification.title, style=f"bold {style}")]
        body = self.notification.body.strip()
        if body:
            body_lines = body.splitlines()
            preview = "\n".join(body_lines[:2])
            if len(body_lines) > 2:
                preview += "\n..."
            lines.append(Text(preview, style="grey50"))
        return BulletColumns(Group(*lines), bullet_style=style)


class _StatusBlock:
    def __init__(self, initial: StatusUpdate) -> None:
        self.text = Text("", justify="right")
        self._context_usage: float = 0.0
        self._context_tokens: int = 0
        self._max_context_tokens: int = 0
        self.update(initial)

    def render(self) -> RenderableType:
        return self.text

    def update(self, status: StatusUpdate) -> None:
        if status.context_usage is not None:
            self._context_usage = status.context_usage
        if status.context_tokens is not None:
            self._context_tokens = status.context_tokens
        if status.max_context_tokens is not None:
            self._max_context_tokens = status.max_context_tokens
        if status.context_usage is not None:
            self.text.plain = format_context_status(
                self._context_usage,
                self._context_tokens,
                self._max_context_tokens,
            )


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
    def __init__(self, initial_status: StatusUpdate, cancel_event: asyncio.Event | None = None):
        self._cancel_event = cancel_event

        self._mooning_spinner: Spinner | None = None
        self._compacting_spinner: Spinner | None = None
        self._mcp_loading_spinner: Spinner | None = None

        self._current_content_block: _ContentBlock | None = None
        self._tool_call_blocks: dict[str, _ToolCallBlock] = {}
        self._last_tool_call_block: _ToolCallBlock | None = None
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

    def compose(self, *, include_status: bool = True) -> RenderableType:
        """Compose the live view display content."""
        blocks: list[RenderableType] = []
        if self._mcp_loading_spinner is not None:
            blocks.append(self._mcp_loading_spinner)
        elif self._mooning_spinner is not None:
            blocks.append(self._mooning_spinner)
        elif self._compacting_spinner is not None:
            blocks.append(self._compacting_spinner)
        else:
            if self._current_content_block is not None:
                blocks.append(self._current_content_block.compose())
            for tool_call in self._tool_call_blocks.values():
                blocks.append(tool_call.compose())
        if self._current_approval_request_panel:
            blocks.append(self._current_approval_request_panel.render())
        if self._current_question_panel:
            blocks.append(self._current_question_panel.render())
        for notification in self._live_notification_blocks:
            blocks.append(notification.compose())

        if include_status:
            blocks.append(self._status_block.render())
        return Group(*blocks)

    def dispatch_wire_message(self, msg: WireMessage) -> None:
        """Dispatch the Wire message to UI components."""
        assert not isinstance(msg, StepInterrupted)  # handled in visualize_loop

        if isinstance(msg, StepBegin):
            self.cleanup(is_interrupt=False)
            self._mcp_loading_spinner = None
            self._mooning_spinner = Spinner("moon", "")
            self.refresh_soon()
            return

        if self._mooning_spinner is not None:
            # any message other than StepBegin should end the mooning state
            self._mooning_spinner = None
            self.refresh_soon()

        match msg:
            case TurnBegin():
                self.flush_content()
            case SteerInput(user_input=user_input):
                self.cleanup(is_interrupt=False)
                content: list[ContentPart]
                if isinstance(user_input, list):
                    content = list(user_input)
                else:
                    content = [TextPart(text=user_input)]
                console.print(render_user_echo(Message(role="user", content=content)))
            case TurnEnd():
                pass
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
            case ApprovalRequest():
                self.request_approval(msg)
            case QuestionRequest():
                self.request_question(msg)
            case ToolCallRequest():
                logger.warning("Unexpected ToolCallRequest in shell UI: {msg}", msg=msg)

    def _try_submit_question(self) -> None:
        """Submit the current question answer; if all done, resolve and advance."""
        panel = self._current_question_panel
        if panel is None:
            return
        all_done = panel.submit()
        if all_done:
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
                        self._try_submit_question()
                case KeyEvent.ENTER:
                    # "Other" is handled in keyboard_handler (async context)
                    self._try_submit_question()
                case KeyEvent.ESCAPE:
                    self._current_question_panel.request.resolve({})
                    self.show_next_question_request()
                case (
                    KeyEvent.NUM_1
                    | KeyEvent.NUM_2
                    | KeyEvent.NUM_3
                    | KeyEvent.NUM_4
                    | KeyEvent.NUM_5
                ):
                    # Number keys select option in question panel
                    num_map = {
                        KeyEvent.NUM_1: 0,
                        KeyEvent.NUM_2: 1,
                        KeyEvent.NUM_3: 2,
                        KeyEvent.NUM_4: 3,
                        KeyEvent.NUM_5: 4,
                    }
                    idx = num_map[event]
                    panel = self._current_question_panel
                    if panel.select_index(idx):
                        if panel.is_multi_select:
                            panel.toggle_select()
                        elif not panel.is_other_selected:
                            # Auto-submit for single-select (unless "Other")
                            self._try_submit_question()
                case _:
                    pass
            self.refresh_soon()
            return

        # handle ESC key to cancel the run
        if event == KeyEvent.ESCAPE and self._cancel_event is not None:
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
                if not text:
                    return
                is_think = isinstance(part, ThinkPart)
                if self._current_content_block is None:
                    self._current_content_block = _ContentBlock(is_think)
                    self.refresh_soon()
                elif self._current_content_block.is_think != is_think:
                    self.flush_content()
                    self._current_content_block = _ContentBlock(is_think)
                    self.refresh_soon()
                self._current_content_block.append(text)
            case _:
                # TODO: support more content part types
                pass

    def append_tool_call(self, tool_call: ToolCall) -> None:
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


class _PromptLiveView(_LiveView):
    modal_priority = 0

    def __init__(
        self,
        initial_status: StatusUpdate,
        *,
        prompt_session: CustomPromptSession,
        steer: Callable[[str | list[ContentPart]], None],
        cancel_event: asyncio.Event | None = None,
    ) -> None:
        super().__init__(initial_status, cancel_event)
        self._prompt_session = prompt_session
        self._steer = steer
        self._pending_local_steers: deque[str | list[ContentPart]] = deque()
        self._turn_ended = False
        self._question_modal: QuestionPromptDelegate | None = None

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
        finally:
            self._external_messages.shutdown(immediate=True)
            for task in (locals().get("wire_task"), locals().get("external_task")):
                if task is None:
                    continue
                task.cancel()
                with suppress(asyncio.CancelledError, QueueShutDown):
                    await task
            self._pending_local_steers.clear()
            self._turn_ended = False
            if self._question_modal is not None:
                self._prompt_session.detach_modal(self._question_modal)
                self._question_modal = None
            self._prompt_session.invalidate()

    def handle_local_input(self, user_input: UserInput) -> None:
        if not user_input or self._turn_ended:
            return

        console.print(render_user_echo_text(user_input.command))
        self._pending_local_steers.append(list(user_input.content))
        self._steer(user_input.content)
        self._flush_prompt_refresh()

    def dispatch_wire_message(self, msg: WireMessage) -> None:
        if isinstance(msg, SteerInput) and self._pending_local_steers:
            pending = self._pending_local_steers[0]
            if pending == msg.user_input:
                self._pending_local_steers.popleft()
                return
        super().dispatch_wire_message(msg)

    def render_running_prompt_body(self, columns: int) -> ANSI:
        if (
            self._turn_ended
            and self._current_approval_request_panel is None
            and self._current_question_panel is None
        ):
            return ANSI("")
        renderable = self.compose(include_status=False)
        body = render_to_ansi(renderable, columns=columns).rstrip("\n")
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

    def should_handle_running_prompt_key(self, key: str) -> bool:
        if key == "c-e":
            return self.has_expandable_panel()
        if self._current_approval_request_panel is not None:
            return key in {"up", "down", "enter", "1", "2", "3", "4"}
        if self._turn_ended:
            return False
        if key == "escape":
            return self._cancel_event is not None
        return False

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        if key == "c-e":
            event.app.create_background_task(self._show_panel_in_pager())
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
            )
            self._prompt_session.attach_modal(self._question_modal)
        else:
            self._question_modal.set_panel(panel)
        self._prompt_session.invalidate()

    def _advance_question(self) -> QuestionRequestPanel | None:
        """Advance to the next question in the queue, returning the new panel or None."""
        self.show_next_question_request()
        return self._current_question_panel
