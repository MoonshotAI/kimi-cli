import asyncio
from collections import deque
from typing import Literal

import streamingjson
from kosong.base.message import ToolCall, ToolCallPart
from kosong.tooling import ToolError, ToolOk, ToolResult, ToolReturnType
from rich import box
from rich.console import Console, ConsoleOptions, Group, RenderableType, RenderResult
from rich.live import Live
from rich.markdown import Heading, Markdown
from rich.markup import escape
from rich.panel import Panel
from rich.spinner import Spinner
from rich.status import Status
from rich.text import Text

from kimi_cli.soul import StatusSnapshot
from kimi_cli.tools import extract_subtitle
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.keyboard import KeyEvent
from kimi_cli.wire.message import ApprovalRequest, ApprovalResponse


class _ToolCallDisplay:
    def __init__(self, tool_call: ToolCall):
        self._tool_name = tool_call.function.name
        self._lexer = streamingjson.Lexer()
        if tool_call.function.arguments is not None:
            self._lexer.append_string(tool_call.function.arguments)

        self._title_markup = f"Using [blue]{self._tool_name}[/blue]"
        self._subtitle = extract_subtitle(self._lexer, self._tool_name)
        self._finished = False
        self._spinner = Spinner("dots", text=self._spinner_markup)
        self.renderable: RenderableType = Group(self._spinner)

    @property
    def finished(self) -> bool:
        return self._finished

    @property
    def _spinner_markup(self) -> str:
        return self._title_markup + self._subtitle_markup

    @property
    def _subtitle_markup(self) -> str:
        subtitle = self._subtitle
        return f"[grey50]: {escape(subtitle)}[/grey50]" if subtitle else ""

    def append_args_part(self, args_part: str):
        if self.finished:
            return
        self._lexer.append_string(args_part)
        # TODO: don't extract detail if it's already stable
        new_subtitle = extract_subtitle(self._lexer, self._tool_name)
        if new_subtitle and new_subtitle != self._subtitle:
            self._subtitle = new_subtitle
            self._spinner.update(text=self._spinner_markup)

    def finish(self, result: ToolReturnType):
        """
        Finish the live display of a tool call.
        After calling this, the `renderable` property should be re-rendered.
        """
        self._finished = True
        sign = "[red]✗[/red]" if isinstance(result, ToolError) else "[green]✓[/green]"
        lines = [
            Text.from_markup(f"{sign} Used [blue]{self._tool_name}[/blue]" + self._subtitle_markup)
        ]
        if result.brief:
            lines.append(
                Text.from_markup(
                    f"  {result.brief}", style="grey50" if isinstance(result, ToolOk) else "red"
                )
            )
        self.renderable = Group(*lines)


class _ApprovalRequestDisplay:
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
        lines = []

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


class StepLiveView:
    def __init__(self, status: StatusSnapshot, cancel_event: asyncio.Event | None = None):
        # message content
        self._line_buffer = Text("")
        self._last_text_mode: Literal["text", "think", ""] = ""

        # tool call
        self._tool_calls: dict[str, _ToolCallDisplay] = {}
        self._last_tool_call: _ToolCallDisplay | None = None

        # approval request
        self._approval_queue = deque[ApprovalRequest]()
        self._current_approval: _ApprovalRequestDisplay | None = None
        self._reject_all_following = False

        # status
        self._status_text: Text | None = Text(
            self._format_status(status), style="grey50", justify="right"
        )
        self._buffer_status: RenderableType | None = None

        # cancel event for ESC key handling
        self._cancel_event = cancel_event

    def __enter__(self):
        self._live = Live(
            self._compose(),
            console=console,
            refresh_per_second=10,
            transient=False,  # leave the last frame on the screen
            vertical_overflow="visible",
        )
        self._live.__enter__()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self._live.__exit__(exc_type, exc_value, traceback)

    def _compose(self) -> RenderableType:
        sections = []
        if self._line_buffer:
            sections.append(self._line_buffer)
        if self._buffer_status:
            sections.append(self._buffer_status)
        for view in self._tool_calls.values():
            sections.append(view.renderable)
        if self._current_approval:
            sections.append(self._current_approval.render())
        if not sections:
            # if there's nothing to display, do not show status bar
            return Group()
        # TODO: pin status bar at the bottom
        if self._status_text:
            sections.append(self._status_text)
        return Group(*sections)

    def _push_out(self, renderable: RenderableType):
        """
        Push the renderable out of the live view to the console.
        After this, the renderable will not be changed further.
        """
        console.print(renderable)

    def append_text(self, text: str, mode: Literal["text", "think"] = "text"):
        if not text:
            # Ignore empty message
            return
        if self._last_text_mode != mode:
            if self._line_buffer:
                self._push_out(self._line_buffer)
                self._push_out("")  # Add extra line between different modes
                self._line_buffer.plain = ""
            self._last_text_mode = mode
            match mode:
                case "text":
                    self._line_buffer.style = ""
                case "think":
                    self._line_buffer.style = "grey50 italic"
        lines = text.split("\n")
        prev_is_empty = not self._line_buffer
        for line in lines[:-1]:
            self._push_out(self._line_buffer + line)
            self._line_buffer.plain = ""
        self._line_buffer.append(lines[-1])
        if (prev_is_empty and self._line_buffer) or (not prev_is_empty and not self._line_buffer):
            self._live.update(self._compose())

    def append_tool_call(self, tool_call: ToolCall):
        self._tool_calls[tool_call.id] = _ToolCallDisplay(tool_call)
        self._last_tool_call = self._tool_calls[tool_call.id]
        self._live.update(self._compose())

    def append_tool_call_part(self, tool_call_part: ToolCallPart):
        if not tool_call_part.arguments_part:
            return
        if self._last_tool_call is None:
            return
        self._last_tool_call.append_args_part(tool_call_part.arguments_part)

    def append_tool_result(self, tool_result: ToolResult):
        if view := self._tool_calls.get(tool_result.tool_call_id):
            view.finish(tool_result.result)
            self._live.update(self._compose())

    def request_approval(self, approval_request: ApprovalRequest) -> None:
        # If we're rejecting all following requests, reject immediately
        if self._reject_all_following:
            approval_request.resolve(ApprovalResponse.REJECT)
            return

        # Add to queue
        self._approval_queue.append(approval_request)

        # If no approval is currently being displayed, show the next one
        if self._current_approval is None:
            self._show_next_approval_request()
            self._live.update(self._compose())

    def _show_next_approval_request(self) -> None:
        """Show the next approval request from the queue."""
        if not self._approval_queue:
            return

        while self._approval_queue:
            request = self._approval_queue.popleft()
            if request.resolved:
                # skip resolved requests
                continue
            self._current_approval = _ApprovalRequestDisplay(request)
            break

    def update_status(self, status: StatusSnapshot):
        if self._status_text is None:
            return
        self._status_text.plain = self._format_status(status)

    def handle_keyboard_event(self, event: KeyEvent):
        # Handle ESC key to cancel the run
        if event == KeyEvent.ESCAPE and self._cancel_event is not None:
            self._cancel_event.set()
            return

        if not self._current_approval:
            # just ignore any keyboard event when there's no approval request
            return

        match event:
            case KeyEvent.UP:
                self._current_approval.move_up()
                self._live.update(self._compose())
            case KeyEvent.DOWN:
                self._current_approval.move_down()
                self._live.update(self._compose())
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
                self._current_approval = None
                self._show_next_approval_request()
                self._live.update(self._compose())
            case _:
                # just ignore any other keyboard event
                return

    def finish(self):
        self._current_approval = None
        for view in self._tool_calls.values():
            if not view.finished:
                # this should not happen, but just in case
                view.finish(ToolOk(output=""))
        self._live.update(self._compose())

    def interrupt(self):
        self._current_approval = None
        for view in self._tool_calls.values():
            if not view.finished:
                view.finish(ToolError(message="", brief="Interrupted"))
        self._live.update(self._compose())

    @staticmethod
    def _format_status(status: StatusSnapshot) -> str:
        bounded = max(0.0, min(status.context_usage, 1.0))
        return f"context: {bounded:.1%}"


class StepLiveViewWithMarkdown(StepLiveView):
    # TODO: figure out a streaming implementation for this

    def __init__(self, status: StatusSnapshot, cancel_event: asyncio.Event | None = None):
        super().__init__(status, cancel_event)
        self._pending_markdown_parts: list[str] = []
        self._buffer_status_active = False
        self._buffer_status_obj: Status | None = None

    def append_text(self, text: str, mode: Literal["text", "think"] = "text"):
        if not text:
            # Ignore empty message
            return
        if self._last_text_mode != mode:
            if self._flush_markdown():
                self._push_out("")  # Add extra line between different modes
            self._last_text_mode = mode
        if not self._pending_markdown_parts:
            self._show_thinking_status()
        self._pending_markdown_parts.append(text)

    def append_tool_call(self, tool_call: ToolCall):
        self._flush_markdown()
        super().append_tool_call(tool_call)

    def finish(self):
        self._flush_markdown()
        super().finish()

    def interrupt(self):
        self._flush_markdown()
        super().interrupt()

    def __exit__(self, exc_type, exc_value, traceback):
        self._flush_markdown()
        return super().__exit__(exc_type, exc_value, traceback)

    def _flush_markdown(self) -> bool:
        self._hide_thinking_status()
        if not self._pending_markdown_parts:
            return False
        markdown_text = "".join(self._pending_markdown_parts)
        self._pending_markdown_parts.clear()
        if markdown_text.strip():
            self._push_out(
                _LeftAlignedMarkdown(
                    markdown_text,
                    justify="left",
                    style="grey50 italic" if self._last_text_mode == "think" else "none",
                )
            )
            return True
        return False

    def _show_thinking_status(self):
        if self._buffer_status_active:
            return
        self._buffer_status_active = True
        self._line_buffer.plain = ""
        self._buffer_status_obj = Status("Composing...", console=console, spinner="dots")
        self._buffer_status = self._buffer_status_obj.renderable
        self._live.update(self._compose())

    def _hide_thinking_status(self):
        if not self._buffer_status_active:
            return
        self._buffer_status_active = False
        if self._buffer_status_obj is not None:
            self._buffer_status_obj.stop()
        self._buffer_status = None
        self._buffer_status_obj = None
        self._live.update(self._compose())


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
