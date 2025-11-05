import asyncio
from abc import ABC, abstractmethod
from collections import deque
from contextlib import asynccontextmanager, suppress
from typing import override

from kosong.base.message import ContentPart, TextPart, ThinkPart, ToolCall, ToolCallPart
from kosong.tooling import ToolResult
from rich import box
from rich.console import Console, ConsoleOptions, Group, RenderableType, RenderResult
from rich.live import Live
from rich.markdown import Heading, Markdown
from rich.panel import Panel
from rich.status import Status
from rich.text import Text
from rich.table import Table
from rich.spinner import Spinner

from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.keyboard import KeyEvent, listen_for_keyboard
from kimi_cli.wire import WireUISide
from kimi_cli.wire.message import (
    ApprovalRequest,
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
    markdown: bool = True,
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


class _Block(ABC):
    @property
    @abstractmethod
    def renderable(self) -> RenderableType: ...

    @property
    def renderable_final(self) -> RenderableType:
        return self.renderable


class _ContentBlock(_Block):
    def __init__(self, is_think: bool):
        self.is_think = is_think
        # self.text = Text(style="grey50 italic" if is_think else "")
        self._composing_spinner = Spinner(
            "dots",
            "Thinking..." if is_think else "Composing...",
        )
        self.raw_text = ""

    @property
    @override
    def renderable(self) -> RenderableType:
        return self._composing_spinner

    @property
    @override
    def renderable_final(self) -> RenderableType:
        return _with_bullet(
            _LeftAlignedMarkdown(
                self.raw_text,
                justify="left",
                style="grey50 italic" if self.is_think else "",
            ),
            "grey50",
        )

    def append(self, content: str) -> None:
        self.raw_text += content


class _ToolCallBlock(_Block):
    def __init__(self) -> None:
        pass

    @property
    @override
    def renderable(self) -> RenderableType:
        return Text("Tool Call Block Placeholder")


class _ApprovalPanel:
    def __init__(self) -> None:
        pass


class _StatusBlock:
    def __init__(self, initial: StatusSnapshot) -> None:
        self.text = Text("", justify="right", style="grey50")
        self.update(initial)

    @property
    def renderable(self) -> RenderableType:
        return self.text

    def update(self, status: StatusSnapshot) -> None:
        self.text.plain = f"context: {status.context_usage:.1%}"


@asynccontextmanager
async def _keyboard_listener(view: "_LiveView"):
    async def _keyboard():
        try:
            async for event in listen_for_keyboard():
                view.handle_keyboard_event(event)
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
        self._tool_call_blocks = dict[str, _ToolCallBlock]()
        self._last_tool_call: _ToolCallBlock | None = None
        self._approval_queue = deque[ApprovalRequest]()
        self._current_approval: _ApprovalPanel | None = None
        self._reject_all_following = False
        self._status_block = _StatusBlock(initial_status)

        self._need_recompose = False

    def refresh_soon(self) -> None:
        self._need_recompose = True

    async def visualize_loop(self, wire: WireUISide):
        with Live(
            self.compose(),
            console=console,
            refresh_per_second=10,
            transient=False,
            vertical_overflow="visible",
        ) as live:
            async with _keyboard_listener(self):
                while True:
                    try:
                        msg = await wire.receive()
                    except asyncio.QueueShutDown:
                        self.finish()
                        live.update(self.compose())
                        break

                    if isinstance(msg, StepInterrupted):
                        self.interrupt()
                        live.update(self.compose())
                        break

                    self.dispatch(msg)
                    if self._need_recompose:
                        live.update(self.compose())
                        self._need_recompose = False

    def compose(self) -> RenderableType:
        blocks: list[RenderableType] = []
        if self._mooning_spinner is not None:
            blocks.append(self._mooning_spinner)
        elif self._compacting_spinner is not None:
            blocks.append(self._compacting_spinner)
        else:
            if self._current_content_block is not None:
                blocks.append(self._current_content_block.renderable)
            for tool_call in self._tool_call_blocks.values():
                blocks.append(tool_call.renderable)
        blocks.append(self._status_block.renderable)
        return Group(*blocks)

    def dispatch(self, msg: WireMessage):
        """
        Dispatch the Wire message to UI components. Returns True if a full recompose is needed.
        """
        assert not isinstance(msg, StepInterrupted)  # handled in visualize_loop

        if isinstance(msg, StepBegin):
            self._mooning_spinner = Spinner("moon", "")
            # TODO: push out blocks of previous step
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

    def interrupt(self) -> None:
        self.push_out_current_content_block()

    def finish(self) -> None:
        self.push_out_current_content_block()

    def push_out_current_content_block(self) -> None:
        if self._current_content_block is not None:
            console.print(self._current_content_block.renderable_final)
            self._current_content_block = None
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
                    self.push_out_current_content_block()
                    self._current_content_block = _ContentBlock(is_think)
                    self.refresh_soon()
                self._current_content_block.append(text)
            case _:
                # TODO: support more content part types
                pass

    def append_tool_call(self, tool_call: ToolCall) -> None:
        self.push_out_current_content_block()
        # console.print(tool_call)
        pass

    def append_tool_call_part(self, part: ToolCallPart) -> None:
        # console.print(part)
        pass

    def append_tool_result(self, result: ToolResult) -> None:
        # console.print(result)
        pass

    def request_approval(self, request: ApprovalRequest) -> None:
        # console.print(request)
        pass

    def handle_keyboard_event(self, event: KeyEvent) -> None:
        # handle ESC key to cancel the run
        if event == KeyEvent.ESCAPE and self._cancel_event is not None:
            self._cancel_event.set()
            return

        if not self._current_approval:
            # just ignore any keyboard event when there's no approval request
            return


class _LeftAlignedHeading(Heading):
    """Heading element with left-aligned content."""

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        text = self.text
        text.justify = "left"
        if self.tag == "h2":
            text.stylize("bold")
        if self.tag == "h1":
            yield Panel(text, box=box.HEAVY, style="markdown.h1.border")
        else:
            if self.tag == "h2":
                yield Text("")
            yield text


class _LeftAlignedMarkdown(Markdown):
    """Markdown renderer that left-aligns headings."""

    elements = dict(Markdown.elements)
    elements["heading_open"] = _LeftAlignedHeading


def _with_bullet(renderable: RenderableType, bullet_style: str) -> RenderableType:
    table = Table.grid(padding=(0, 0))
    table.expand = True
    table.add_column(width=2, justify="left", style=bullet_style)
    table.add_column(ratio=1)
    table.add_row(Text("•"), renderable)
    return table
