from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import Any, NamedTuple, cast

import streamingjson  # type: ignore[reportMissingTypeStubs]
from kosong.tooling import ToolError, ToolOk
from rich.console import Group, RenderableType
from rich.live import Live
from rich.markup import escape
from rich.padding import Padding
from rich.panel import Panel
from rich.spinner import Spinner
from rich.style import Style
from rich.text import Text

from kimi_cli.tools import extract_key_argument
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.keyboard import KeyboardListener, KeyEvent
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.utils.diff import format_unified_diff
from kimi_cli.utils.logging import logger
from kimi_cli.utils.rich.columns import BulletColumns
from kimi_cli.utils.rich.markdown import Markdown
from kimi_cli.utils.rich.syntax import KimiSyntax
from kimi_cli.wire import WireUISide
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BriefDisplayBlock,
    CompactionBegin,
    CompactionEnd,
    ContentPart,
    DiffDisplayBlock,
    QuestionRequest,
    ShellDisplayBlock,
    StatusUpdate,
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

# Truncation limits for approval request display
MAX_PREVIEW_LINES = 4


async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusUpdate,
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

    def _compose(self) -> RenderableType:
        lines: list[RenderableType] = [
            self._build_headline_text(),
        ]

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
            args = json.loads(arguments)
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


class _ApprovalContentBlock(NamedTuple):
    """A pre-rendered content block for approval request with line count."""

    text: str
    lines: int
    style: str = ""
    lexer: str = ""


class _ApprovalRequestPanel:
    def __init__(self, request: ApprovalRequest):
        self.request = request
        self.options: list[tuple[str, ApprovalResponse.Kind]] = [
            ("Approve once", "approve"),
            ("Approve for this session", "approve_for_session"),
            ("Reject, tell Kimi what to do instead", "reject"),
        ]
        self.selected_index = 0

        # Pre-render all content blocks with line counts
        self._content_blocks: list[_ApprovalContentBlock] = []
        last_diff_path: str | None = None

        # Handle description (only if no display blocks)
        if request.description and not request.display:
            text = request.description.rstrip("\n")
            self._content_blocks.append(
                _ApprovalContentBlock(text=text, lines=text.count("\n") + 1)
            )

        # Handle display blocks
        for block in request.display:
            if isinstance(block, DiffDisplayBlock):
                # File path or ellipsis
                if block.path != last_diff_path:
                    self._content_blocks.append(
                        _ApprovalContentBlock(text=block.path, lines=1, style="bold")
                    )
                    last_diff_path = block.path
                else:
                    self._content_blocks.append(
                        _ApprovalContentBlock(text="⋮", lines=1, style="dim")
                    )
                # Diff content
                diff_text = format_unified_diff(
                    block.old_text,
                    block.new_text,
                    block.path,
                    include_file_header=False,
                ).rstrip("\n")
                self._content_blocks.append(
                    _ApprovalContentBlock(
                        text=diff_text, lines=diff_text.count("\n") + 1, lexer="diff"
                    )
                )
            elif isinstance(block, ShellDisplayBlock):
                text = block.command.rstrip("\n")
                self._content_blocks.append(
                    _ApprovalContentBlock(
                        text=text, lines=text.count("\n") + 1, lexer=block.language
                    )
                )
                last_diff_path = None
            elif isinstance(block, BriefDisplayBlock) and block.text:
                text = block.text.rstrip("\n")
                self._content_blocks.append(
                    _ApprovalContentBlock(text=text, lines=text.count("\n") + 1, style="grey50")
                )
                last_diff_path = None

        self._total_lines = sum(b.lines for b in self._content_blocks)
        self.has_expandable_content = self._total_lines > MAX_PREVIEW_LINES

    def render(self) -> RenderableType:
        """Render the approval menu as a bordered panel."""
        content_lines: list[RenderableType] = [
            Text.from_markup(
                "[yellow]"
                f"{escape(self.request.sender)} is requesting approval to "
                f"{escape(self.request.action)}:[/yellow]"
            )
        ]
        content_lines.append(Text(""))

        # Render content with line budget
        remaining = MAX_PREVIEW_LINES
        for block in self._content_blocks:
            if remaining <= 0:
                break
            content_lines.append(self._render_block(block, remaining))
            remaining -= min(block.lines, remaining)

        if self.has_expandable_content:
            content_lines.append(Text("... (truncated, ctrl-e to expand)", style="dim italic"))

        lines: list[RenderableType] = []
        if content_lines:
            lines.append(Padding(Group(*content_lines), (0, 0, 0, 1)))

        # Add menu options with number key labels
        if lines:
            lines.append(Text(""))
        for i, (option_text, _) in enumerate(self.options):
            num = i + 1
            if i == self.selected_index:
                lines.append(Text(f"\u2192 [{num}] {option_text}", style="cyan"))
            else:
                lines.append(Text(f"  [{num}] {option_text}", style="grey50"))

        # Keyboard hints
        lines.append(Text(""))
        hint = "  \u25b2/\u25bc select  1/2/3 choose  \u21b5 confirm"
        if self.has_expandable_content:
            hint += "  ctrl-e expand"
        lines.append(Text(hint, style="dim"))

        return Panel(
            Group(*lines),
            border_style="bold yellow",
            title="[bold yellow]\u26a0 ACTION REQUIRED[/bold yellow]",
            title_align="left",
            padding=(0, 1),
        )

    def _render_block(
        self, block: _ApprovalContentBlock, max_lines: int | None = None
    ) -> RenderableType:
        """Render a content block, optionally truncated."""
        text = block.text
        if max_lines is not None and block.lines > max_lines:
            # Truncate to max_lines
            text = "\n".join(text.split("\n")[:max_lines])

        if block.lexer:
            return KimiSyntax(text, block.lexer)
        return Text(text, style=block.style)

    def render_full(self) -> list[RenderableType]:
        """Render full content for pager (no truncation)."""
        return [self._render_block(block) for block in self._content_blocks]

    def move_up(self):
        """Move selection up."""
        self.selected_index = (self.selected_index - 1) % len(self.options)

    def move_down(self):
        """Move selection down."""
        self.selected_index = (self.selected_index + 1) % len(self.options)

    def get_selected_response(self) -> ApprovalResponse.Kind:
        """Get the approval response based on selected option."""
        return self.options[self.selected_index][1]


def _show_approval_in_pager(panel: _ApprovalRequestPanel) -> None:
    """Show the full approval request content in a pager."""
    with console.screen(), console.pager(styles=True):
        # Header: matches the style in _ApprovalRequestPanel.render()
        console.print(
            Text.from_markup(
                "[yellow]⚠ "
                f"{escape(panel.request.sender)} is requesting approval to "
                f"{escape(panel.request.action)}:[/yellow]"
            )
        )
        console.print()

        # Render full content (no truncation)
        for renderable in panel.render_full():
            console.print(renderable)


OTHER_OPTION_LABEL = "Other"


class _QuestionRequestPanel:
    """Renders structured questions for the user to answer interactively."""

    def __init__(self, request: QuestionRequest):
        self.request = request
        self._current_question_index = 0
        self._answers: dict[str, str] = {}
        self._saved_selections: dict[int, tuple[int, set[int]]] = {}
        self._selected_index = 0
        self._multi_selected: set[int] = set()
        self._setup_current_question()

    def _setup_current_question(self) -> None:
        q = self._current_question
        self._options = [(o.label, o.description) for o in q.options]
        self._options.append((OTHER_OPTION_LABEL, "Provide custom text input"))
        idx = self._current_question_index
        if idx in self._saved_selections:
            saved_idx, saved_multi = self._saved_selections[idx]
            self._selected_index = min(saved_idx, len(self._options) - 1)
            self._multi_selected = saved_multi
        elif q.question in self._answers:
            answer = self._answers[q.question]
            if q.multi_select:
                answer_labels = [a.strip() for a in answer.split(", ")]
                known_labels = {label for label, _ in self._options[:-1]}
                self._multi_selected = set()
                for i, (label, _) in enumerate(self._options[:-1]):
                    if label in answer_labels:
                        self._multi_selected.add(i)
                # Unmatched labels = Other text
                if any(answer_label not in known_labels for answer_label in answer_labels):
                    self._multi_selected.add(len(self._options) - 1)
                self._selected_index = min(self._multi_selected) if self._multi_selected else 0
            else:
                for i, (label, _) in enumerate(self._options):
                    if label == answer:
                        self._selected_index = i
                        break
                else:
                    # Unknown submitted label should map to the synthetic "Other" option.
                    self._selected_index = len(self._options) - 1
                self._multi_selected = set()
        else:
            self._selected_index = 0
            self._multi_selected = set()

    @property
    def _current_question(self):
        return self.request.questions[self._current_question_index]

    @property
    def is_other_selected(self) -> bool:
        return self._selected_index == len(self._options) - 1

    @property
    def is_multi_select(self) -> bool:
        return self._current_question.multi_select

    @property
    def current_question_text(self) -> str:
        return self._current_question.question

    def should_prompt_other_input(self) -> bool:
        """Whether pressing ENTER should open free-text input for the current question."""
        if not self.is_multi_select:
            return self.is_other_selected
        other_idx = len(self._options) - 1
        return other_idx in self._multi_selected

    def select_index(self, index: int) -> bool:
        """Select an option by index. Returns False when index is out of range."""
        if not (0 <= index < len(self._options)):
            return False
        self._selected_index = index
        return True

    def render(self) -> RenderableType:
        q = self._current_question
        lines: list[RenderableType] = []

        # Tab bar for multi-question navigation
        if len(self.request.questions) > 1:
            tab_parts: list[str] = []
            for i, qi in enumerate(self.request.questions):
                label = escape(qi.header or f"Q{i + 1}")
                if i == self._current_question_index:
                    icon, style = "\u25cf", "bold cyan"
                elif qi.question in self._answers:
                    icon, style = "\u2713", "green"
                else:
                    icon, style = "\u25cb", "grey50"
                tab_parts.append(f"[{style}]({icon}) {label}[/{style}]")
            lines.append(Text.from_markup("  ".join(tab_parts)))
            lines.append(Text(""))

        # Question text (header is now shown in the tab bar)
        lines.append(Text.from_markup(f"[yellow]? {escape(q.question)}[/yellow]"))
        if q.multi_select:
            lines.append(Text("  (SPACE to toggle, ENTER to submit)", style="dim italic"))
        lines.append(Text(""))

        # Options with number key labels
        for i, (label, description) in enumerate(self._options):
            num = i + 1
            if q.multi_select:
                checked = "\u2713" if i in self._multi_selected else " "
                prefix = f"\\[{checked}]"
                if i == self._selected_index:
                    option_line = Text.from_markup(f"[cyan]{prefix} {escape(label)}[/cyan]")
                else:
                    option_line = Text.from_markup(f"[grey50]{prefix} {escape(label)}[/grey50]")
            else:
                if i == self._selected_index:
                    option_line = Text.from_markup(f"[cyan]\u2192 \\[{num}] {escape(label)}[/cyan]")
                else:
                    option_line = Text.from_markup(f"[grey50]  \\[{num}] {escape(label)}[/grey50]")
            lines.append(option_line)

            if description and label != OTHER_OPTION_LABEL:
                lines.append(Text(f"      {description}", style="dim"))

        # Keyboard hint for multi-question
        if len(self.request.questions) > 1:
            lines.append(Text(""))
            lines.append(
                Text(
                    "  \u25c4/\u25ba switch question  "
                    "\u25b2/\u25bc select  \u21b5 submit  esc exit",
                    style="dim",
                )
            )

        return Panel(
            Group(*lines),
            border_style="bold cyan",
            title="[bold cyan]? QUESTION[/bold cyan]",
            title_align="left",
            padding=(0, 1),
        )

    def go_to(self, index: int) -> None:
        """Jump to a specific question by index, saving current UI state first."""
        if index == self._current_question_index:
            return
        if not (0 <= index < len(self.request.questions)):
            return
        # Save current cursor state (not as an answer — only submit() writes answers)
        self._saved_selections[self._current_question_index] = (
            self._selected_index,
            set(self._multi_selected),
        )
        self._current_question_index = index
        self._setup_current_question()

    def next_tab(self) -> None:
        """Switch to the next question tab (no wrap)."""
        if self._current_question_index < len(self.request.questions) - 1:
            self.go_to(self._current_question_index + 1)

    def prev_tab(self) -> None:
        """Switch to the previous question tab (no wrap)."""
        if self._current_question_index > 0:
            self.go_to(self._current_question_index - 1)

    def move_up(self) -> None:
        self._selected_index = (self._selected_index - 1) % len(self._options)

    def move_down(self) -> None:
        self._selected_index = (self._selected_index + 1) % len(self._options)

    def toggle_select(self) -> None:
        """Toggle selection for multi-select mode."""
        if not self.is_multi_select:
            return
        if self._selected_index in self._multi_selected:
            self._multi_selected.discard(self._selected_index)
        else:
            self._multi_selected.add(self._selected_index)

    def submit(self) -> bool:
        """Submit the current answer and advance. Returns True if all questions are answered."""
        q = self._current_question
        if q.multi_select:
            # Check if "Other" is among the selected
            other_idx = len(self._options) - 1
            if other_idx in self._multi_selected:
                return False  # caller should handle Other input
            selected_labels = [
                self._options[i][0] for i in sorted(self._multi_selected) if i < len(q.options)
            ]
            if not selected_labels:
                return False  # don't allow empty multi-select submission
            self._answers[q.question] = ", ".join(selected_labels)
        else:
            if self.is_other_selected:
                return False  # caller should handle Other input
            self._answers[q.question] = self._options[self._selected_index][0]
        # Clear stale draft so returning to this question uses the submitted answer
        self._saved_selections.pop(self._current_question_index, None)
        return self._advance()

    def submit_other(self, text: str) -> bool:
        """Submit 'Other' text for the current question. Returns True if all done."""
        q = self._current_question
        if q.multi_select:
            # Include both selected options and the custom text
            other_idx = len(self._options) - 1
            selected_labels = [
                self._options[i][0]
                for i in sorted(self._multi_selected)
                if i < len(q.options) and i != other_idx
            ]
            if text:
                selected_labels.append(text)
            self._answers[q.question] = ", ".join(selected_labels) if selected_labels else text
        else:
            self._answers[q.question] = text
        # Clear stale draft so returning to this question uses the submitted answer
        self._saved_selections.pop(self._current_question_index, None)
        return self._advance()

    def _advance(self) -> bool:
        """Move to the next unanswered question. Returns True if all questions are done."""
        total = len(self.request.questions)
        # Check if all questions have been answered
        if len(self._answers) >= total:
            return True
        # Find the next unanswered question (starting from current + 1, wrapping)
        for offset in range(1, total + 1):
            idx = (self._current_question_index + offset) % total
            if self.request.questions[idx].question not in self._answers:
                self._current_question_index = idx
                self._setup_current_question()
                return False
        return True

    def get_answers(self) -> dict[str, str]:
        return self._answers


def _prompt_other_input(question_text: str) -> str:
    """Prompt the user for free-text input when 'Other' is selected."""
    console.print(Text.from_markup(f"\n[yellow]? {escape(question_text)}[/yellow]"))
    console.print(Text("  Enter your answer:", style="dim"))
    try:
        return input("  > ").strip()
    except (EOFError, KeyboardInterrupt):
        return ""


class _StatusBlock:
    def __init__(self, initial: StatusUpdate) -> None:
        self.text = Text("", justify="right")
        self.update(initial)

    def render(self) -> RenderableType:
        return self.text

    def update(self, status: StatusUpdate) -> None:
        if status.context_usage is not None:
            self.text.plain = f"context: {status.context_usage:.1%}"


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

        self._current_content_block: _ContentBlock | None = None
        self._tool_call_blocks: dict[str, _ToolCallBlock] = {}
        self._last_tool_call_block: _ToolCallBlock | None = None
        self._approval_request_queue = deque[ApprovalRequest]()
        """
        It is possible that multiple subagents request approvals at the same time,
        in which case we will have to queue them up and show them one by one.
        """
        self._current_approval_request_panel: _ApprovalRequestPanel | None = None
        self._reject_all_following = False
        self._question_request_queue = deque[QuestionRequest]()
        self._current_question_panel: _QuestionRequestPanel | None = None
        self._status_block = _StatusBlock(initial_status)

        self._need_recompose = False

    def _reset_live_shape(self, live: Live) -> None:
        # Rich doesn't expose a public API to clear Live's cached render height.
        # After leaving the pager, stale height causes cursor restores to jump,
        # so we reset the private _shape to re-anchor the next refresh.
        live._live_render._shape = None  # type: ignore[reportPrivateUsage]

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
                    if (
                        self._current_approval_request_panel
                        and self._current_approval_request_panel.has_expandable_content
                    ):
                        await listener.pause()
                        live.stop()
                        try:
                            _show_approval_in_pager(self._current_approval_request_panel)
                        finally:
                            # Reset live render shape so the next refresh re-anchors cleanly.
                            self._reset_live_shape(live)
                            live.start()
                            live.update(self.compose(), refresh=True)
                            await listener.resume()
                    return

                # Handle ENTER/SPACE on question panel when "Other" is selected
                panel = self._current_question_panel
                _is_submit_key = event == KeyEvent.ENTER or (
                    event == KeyEvent.SPACE and panel is not None and not panel.is_multi_select
                )
                if _is_submit_key and panel is not None and panel.should_prompt_other_input():
                    question_text = panel.current_question_text
                    await listener.pause()
                    live.stop()
                    try:
                        text = _prompt_other_input(question_text)
                    finally:
                        self._reset_live_shape(live)
                        live.start()
                        await listener.resume()

                    all_done = panel.submit_other(text)
                    if all_done:
                        panel.request.resolve(panel.get_answers())
                        self.show_next_question_request()
                    live.update(self.compose(), refresh=True)
                    return

                self.dispatch_keyboard_event(event)
                if self._need_recompose:
                    live.update(self.compose(), refresh=True)
                    self._need_recompose = False

            async with _keyboard_listener(keyboard_handler):
                while True:
                    try:
                        msg = await wire.receive()
                    except QueueShutDown:
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
        if self._current_approval_request_panel:
            blocks.append(self._current_approval_request_panel.render())
        if self._current_question_panel:
            blocks.append(self._current_question_panel.render())

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
            # any message other than StepBegin should end the mooning state
            self._mooning_spinner = None
            self.refresh_soon()

        match msg:
            case TurnBegin():
                self.flush_content()
            case TurnEnd():
                pass
            case CompactionBegin():
                self._compacting_spinner = Spinner("balloon", "Compacting...")
                self.refresh_soon()
            case CompactionEnd():
                self._compacting_spinner = None
                self.refresh_soon()
            case StatusUpdate():
                self._status_block.update(msg)
            case ContentPart():
                self.append_content(msg)
            case ToolCall():
                self.append_tool_call(msg)
            case ToolCallPart():
                self.append_tool_call_part(msg)
            case ToolResult():
                self.append_tool_result(msg)
            case ApprovalResponse():
                # we don't need to handle this because the request is resolved on UI
                pass
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
                case KeyEvent.NUM_1 | KeyEvent.NUM_2 | KeyEvent.NUM_3:
                    # Number keys directly select and submit approval option
                    num_map = {
                        KeyEvent.NUM_1: 0,
                        KeyEvent.NUM_2: 1,
                        KeyEvent.NUM_3: 2,
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
        resp = self._current_approval_request_panel.get_selected_response()
        self._current_approval_request_panel.request.resolve(resp)
        if resp == "approve_for_session":
            to_remove_from_queue: list[ApprovalRequest] = []
            for request in self._approval_request_queue:
                # approve all queued requests with the same action
                if request.action == self._current_approval_request_panel.request.action:
                    request.resolve("approve_for_session")
                    to_remove_from_queue.append(request)
            for request in to_remove_from_queue:
                self._approval_request_queue.remove(request)
        elif resp == "reject":
            # one rejection should stop the step immediately
            while self._approval_request_queue:
                self._approval_request_queue.popleft().resolve("reject")
            self._reject_all_following = True
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

        while self._approval_request_queue:
            # should not happen, but just in case
            self._approval_request_queue.popleft().resolve("reject")
        self._current_approval_request_panel = None
        self._reject_all_following = False

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

    def request_approval(self, request: ApprovalRequest) -> None:
        # If we're rejecting all following requests, reject immediately
        if self._reject_all_following:
            request.resolve("reject")
            return

        self._approval_request_queue.append(request)

        if self._current_approval_request_panel is None:
            console.bell()
            self.show_next_approval_request()

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
            self._current_approval_request_panel = _ApprovalRequestPanel(request)
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
            return

        while self._question_request_queue:
            request = self._question_request_queue.popleft()
            if request.resolved:
                continue
            self._current_question_panel = _QuestionRequestPanel(request)
            self.refresh_soon()
            break
        else:
            # All queued requests were already resolved
            if self._current_question_panel is not None:
                self._current_question_panel = None
                self.refresh_soon()

    def handle_subagent_event(self, event: SubagentEvent) -> None:
        block = self._tool_call_blocks.get(event.task_tool_call_id)
        if block is None:
            return

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
