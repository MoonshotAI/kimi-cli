import asyncio
from collections import deque
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress

import streamingjson  # pyright: ignore[reportMissingTypeStubs]
from kosong.base.message import ContentPart, TextPart, ThinkPart, ToolCall, ToolCallPart
from kosong.tooling import ToolError, ToolOk, ToolResult, ToolReturnType
from rich.console import Group, RenderableType
from rich.live import Live
from rich.markup import escape
from rich.panel import Panel
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

from kimi_cli.soul import StatusSnapshot
from kimi_cli.tools import extract_key_argument
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.keyboard import KeyEvent, listen_for_keyboard
from kimi_cli.utils.rich.markdown import Markdown
from kimi_cli.wire import WireUISide
from kimi_cli.wire.message import (
    ApprovalRequest,
    ApprovalResponse,
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    WireMessage,
)


async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusSnapshot,
    cancel_event: asyncio.Event | None = None,
):
    """
    A loop to consume agent events and visualize the agent behavior.

    Args:
        wire: Communication channel with the agent
        initial_status: Initial status snapshot
        cancel_event: Event that can be set (e.g., by ESC key) to cancel the run
    """
    view = _LiveView(initial_status, cancel_event)
    await view.visualize_loop(wire)


class _ContentBlock:
    def __init__(self, is_think: bool):
        self.is_think = is_think
        self._spinner = Spinner("dots", "Thinking..." if is_think else "Composing...")
        self.raw_text = ""

    def compose(self) -> RenderableType:
        return self._spinner

    def compose_final(self) -> RenderableType:
        return _with_bullet(
            Markdown(
                self.raw_text,
                style="grey50 italic" if self.is_think else "",
            ),
            bullet_style="grey50",
        )

    def append(self, content: str) -> None:
        self.raw_text += content


class _ToolCallBlock:
    def __init__(self, tool_call: ToolCall):
        self._tool_name = tool_call.function.name
        self._lexer = streamingjson.Lexer()
        if tool_call.function.arguments is not None:
            self._lexer.append_string(tool_call.function.arguments)

        self._argument = extract_key_argument(self._lexer, self._tool_name)
        self._result: ToolReturnType | None = None
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
            self._renderable: RenderableType = _with_bullet(
                Text.from_markup(self._get_headline_markup()),
                bullet=self._spinning_dots,
            )

    def finish(self, result: ToolReturnType):
        self._result = result
        self._renderable = self._compose()

    def _compose(self) -> RenderableType:
        lines: list[RenderableType] = [
            Text.from_markup(self._get_headline_markup()),
        ]
        if self._result is not None and self._result.brief:
            lines.append(
                Markdown(
                    self._result.brief,
                    style="grey50" if isinstance(self._result, ToolOk) else "red",
                )
            )
        if self.finished:
            return _with_bullet(
                Group(*lines),
                bullet_style="green" if isinstance(self._result, ToolOk) else "red",
            )
        else:
            return _with_bullet(
                Group(*lines),
                bullet=self._spinning_dots,
            )

    def _get_headline_markup(self) -> str:
        return f"{'Used' if self.finished else 'Using'} [blue]{self._tool_name}[/blue]" + (
            f" [grey50]({escape(self._argument)})[/grey50]" if self._argument else ""
        )


class _ApprovalRequestPanel:
    def __init__(self, request: ApprovalRequest):
        self.request = request
        self.options = [
            ("Approve", ApprovalResponse.APPROVE),
            ("Approve for this session", ApprovalResponse.APPROVE_FOR_SESSION),
            ("Reject, tell Kimi CLI what to do instead", ApprovalResponse.REJECT),
        ]
        self.selected_index = 0

    def render(self) -> RenderableType:
        """Render the approval menu as a panel."""
        lines: list[RenderableType] = []

        # Add request details
        lines.append(
            Text(f'{self.request.sender} is requesting approval to "{self.request.description}".')
        )

        lines.append(Text(""))  # Empty line

        # Add menu options
        for i, (option_text, _) in enumerate(self.options):
            if i == self.selected_index:
                lines.append(Text(f"→ {option_text}", style="cyan"))
            else:
                lines.append(Text(f"  {option_text}", style="grey50"))

        content = Group(*lines)
        return Panel.fit(
            content,
            title="[yellow]⚠ Approval Requested[/yellow]",
            border_style="yellow",
            padding=(1, 2),
        )

    def move_up(self):
        """Move selection up."""
        self.selected_index = (self.selected_index - 1) % len(self.options)

    def move_down(self):
        """Move selection down."""
        self.selected_index = (self.selected_index + 1) % len(self.options)

    def get_selected_response(self) -> ApprovalResponse:
        """Get the approval response based on selected option."""
        return self.options[self.selected_index][1]


class _StatusBlock:
    def __init__(self, initial: StatusSnapshot) -> None:
        self.text = Text("", justify="right", style="grey50")
        self.update(initial)

    def render(self) -> RenderableType:
        return self.text

    def update(self, status: StatusSnapshot) -> None:
        self.text.plain = f"context: {status.context_usage:.1%}"


@asynccontextmanager
async def _keyboard_listener(handler: Callable[[KeyEvent], None]):
    async def _keyboard():
        try:
            async for event in listen_for_keyboard():
                handler(event)
        except asyncio.CancelledError:
            return

    task = asyncio.create_task(_keyboard())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


class _LiveView:
    def __init__(self, initial_status: StatusSnapshot, cancel_event: asyncio.Event | None = None):
        self._cancel_event = cancel_event

        self._mooning_spinner: Spinner | None = None
        self._compacting_spinner: Spinner | None = None

        self._current_content_block: _ContentBlock | None = None
        self._tool_call_blocks: dict[str, _ToolCallBlock] = {}
        self._last_tool_call_block: _ToolCallBlock | None = None
        self._approval_queue = deque[ApprovalRequest]()
        self._current_approval: _ApprovalRequestPanel | None = None
        self._reject_all_following = False
        self._status_block = _StatusBlock(initial_status)

        self._need_recompose = False

    async def visualize_loop(self, wire: WireUISide):
        with Live(
            self.compose(),
            console=console,
            refresh_per_second=10,
            transient=True,
            vertical_overflow="visible",
        ) as live:

            def keyboard_handler(event: KeyEvent) -> None:
                self.dispatch_keyboard_event(event)
                if self._need_recompose:
                    live.update(self.compose())
                    self._need_recompose = False

            async with _keyboard_listener(keyboard_handler):
                while True:
                    try:
                        msg = await wire.receive()
                    except asyncio.QueueShutDown:
                        self.cleanup(is_interrupt=False)
                        live.update(self.compose())
                        break

                    if isinstance(msg, StepInterrupted):
                        self.cleanup(is_interrupt=True)
                        live.update(self.compose())
                        break

                    self.dispatch_wire_message(msg)
                    if self._need_recompose:
                        live.update(self.compose())
                        self._need_recompose = False

    def refresh_soon(self) -> None:
        self._need_recompose = True

    def compose(self) -> RenderableType:
        """Compose the live view display content."""
        blocks: list[RenderableType] = []
        if self._mooning_spinner is not None:
            blocks.append(self._mooning_spinner)
        elif self._compacting_spinner is not None:
            blocks.append(self._compacting_spinner)
        else:
            if self._current_content_block is not None:
                blocks.append(self._current_content_block.compose())
            for tool_call in self._tool_call_blocks.values():
                blocks.append(tool_call.compose())
        if self._current_approval:
            blocks.append(self._current_approval.render())
        blocks.append(self._status_block.render())
        return Group(*blocks)

    def dispatch_wire_message(self, msg: WireMessage) -> None:
        """Dispatch the Wire message to UI components."""
        assert not isinstance(msg, StepInterrupted)  # handled in visualize_loop

        if isinstance(msg, StepBegin):
            self.cleanup(is_interrupt=False)
            self._mooning_spinner = Spinner("moon", "")
            self.refresh_soon()
            return

        if self._mooning_spinner is not None:
            self._mooning_spinner = None
            self.refresh_soon()

        match msg:
            case CompactionBegin():
                self._compacting_spinner = Spinner("balloon", "Compacting...")
                self.refresh_soon()
            case CompactionEnd():
                self._compacting_spinner = None
                self.refresh_soon()
            case StatusUpdate(status=status):
                self._status_block.update(status)
            case ContentPart():
                self.append_content(msg)
            case ToolCall():
                self.append_tool_call(msg)
            case ToolCallPart():
                self.append_tool_call_part(msg)
            case ToolResult():
                self.append_tool_result(msg)
            case ApprovalRequest():
                self.request_approval(msg)

    def dispatch_keyboard_event(self, event: KeyEvent) -> None:
        # handle ESC key to cancel the run
        if event == KeyEvent.ESCAPE and self._cancel_event is not None:
            self._cancel_event.set()
            return

        if not self._current_approval:
            # just ignore any keyboard event when there's no approval request
            return

        match event:
            case KeyEvent.UP:
                self._current_approval.move_up()
                self.refresh_soon()
            case KeyEvent.DOWN:
                self._current_approval.move_down()
                self.refresh_soon()
            case KeyEvent.ENTER:
                resp = self._current_approval.get_selected_response()
                self._current_approval.request.resolve(resp)
                if resp == ApprovalResponse.APPROVE_FOR_SESSION:
                    for request in self._approval_queue:
                        # approve all queued requests with the same action
                        if request.action == self._current_approval.request.action:
                            request.resolve(ApprovalResponse.APPROVE_FOR_SESSION)
                elif resp == ApprovalResponse.REJECT:
                    # one rejection should stop the step immediately
                    while self._approval_queue:
                        self._approval_queue.popleft().resolve(ApprovalResponse.REJECT)
                    self._reject_all_following = True
                self.show_next_approval_request()
            case _:
                # just ignore any other keyboard event
                return

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

        for request in self._approval_queue:
            if not request.resolved:
                request.resolve(ApprovalResponse.REJECT)
        self._current_approval = None
        self._reject_all_following = False

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

    def append_tool_result(self, result: ToolResult) -> None:
        if block := self._tool_call_blocks.get(result.tool_call_id):
            block.finish(result.result)
            self.flush_finished_tool_calls()

    def request_approval(self, request: ApprovalRequest) -> None:
        # If we're rejecting all following requests, reject immediately
        if self._reject_all_following:
            request.resolve(ApprovalResponse.REJECT)
            return

        self._approval_queue.append(request)

        if self._current_approval is None:
            self.show_next_approval_request()

    def show_next_approval_request(self) -> None:
        """
        Show the next approval request from the queue.
        If there are no pending requests, clear the current approval panel.
        """
        if not self._approval_queue:
            if self._current_approval is not None:
                self._current_approval = None
                self.refresh_soon()
            return

        while self._approval_queue:
            request = self._approval_queue.popleft()
            if request.resolved:
                # skip resolved requests
                continue
            self._current_approval = _ApprovalRequestPanel(request)
            self.refresh_soon()
            break


def _with_bullet(
    renderable: RenderableType,
    *,
    bullet_style: str | None = None,
    bullet: RenderableType | None = None,
) -> RenderableType:
    table = Table.grid(padding=(0, 0))
    table.expand = True
    table.add_column(width=2, justify="left", style=bullet_style)
    table.add_column(ratio=1)
    if bullet is None:
        bullet = Text("•")
    table.add_row(bullet, renderable)
    return table
