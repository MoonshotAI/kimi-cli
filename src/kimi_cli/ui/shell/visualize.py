from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import TYPE_CHECKING, Any, NamedTuple, cast

if TYPE_CHECKING:
    from markdown_it import MarkdownIt

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
from rich.panel import Panel
from rich.spinner import Spinner
from rich.style import Style
from rich.text import Text

from kimi_cli.soul import format_context_status, format_token_count
from kimi_cli.tools import extract_key_argument
from kimi_cli.ui.shell.approval_panel import (
    ApprovalPromptDelegate as ApprovalPromptDelegate,  # noqa: F401 — re-exported
)
from kimi_cli.ui.shell.approval_panel import (
    ApprovalRequestPanel,
    show_approval_in_pager,
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
from kimi_cli.utils.rich.diff_render import (
    collect_diff_hunks,
    render_diff_panel,
    render_diff_summary_panel,
)
from kimi_cli.utils.rich.markdown import Markdown
from kimi_cli.wire import WireUISide
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BackgroundTaskDisplayBlock,
    BriefDisplayBlock,
    BtwBegin,
    BtwEnd,
    CompactionBegin,
    CompactionEnd,
    ContentPart,
    DiffDisplayBlock,
    MCPLoadingBegin,
    MCPLoadingEnd,
    Notification,
    PlanDisplay,
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


BtwRunner = Callable[[str, Callable[[str], None] | None], Awaitable[tuple[str | None, str | None]]]
"""async (question, on_text_chunk) -> (response, error). Used for direct btw execution."""


# ---------------------------------------------------------------------------
# Unified input routing
# ---------------------------------------------------------------------------
# All user input — whether idle or streaming — passes through
# ``classify_input`` to decide what to do with it.  This is the single
# place where btw / queue / steer / send decisions are made.
# ---------------------------------------------------------------------------


class InputAction:
    """The result of classifying user input."""

    __slots__ = ("kind", "args")

    # Action kinds
    BTW = "btw"
    """Run a side question locally (never reaches the wire)."""
    QUEUE = "queue"
    """Hold and send as a new turn after the current turn ends."""
    SEND = "send"
    """Send to the soul immediately (idle default)."""
    IGNORED = "ignored"
    """Input was recognized but invalid (e.g. /btw without question). ``args`` has a reason."""

    def __init__(self, kind: str, args: str = "") -> None:
        self.kind = kind
        self.args = args


def classify_input(text: str, *, is_streaming: bool) -> InputAction:
    """Classify user input into an action.

    This is the **single routing decision point** for all user input
    (except Ctrl+S steer, which is key-level, not submission-level).
    To add a new local command, add a branch here.
    """
    from kimi_cli.utils.slashcmd import parse_slash_command_call

    if (cmd := parse_slash_command_call(text.strip())) and cmd.name == "btw":
        if cmd.args.strip():
            return InputAction(InputAction.BTW, cmd.args.strip())
        return InputAction(InputAction.IGNORED, "Usage: /btw <question>")

    # During streaming, default is queue; otherwise send to soul
    if is_streaming:
        return InputAction(InputAction.QUEUE)
    return InputAction(InputAction.SEND)


async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusUpdate,
    cancel_event: asyncio.Event | None = None,
    prompt_session: CustomPromptSession | None = None,
    steer: Callable[[str | list[ContentPart]], None] | None = None,
    btw_runner: BtwRunner | None = None,
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
            btw_runner=btw_runner,
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


_THINKING_PREVIEW_LINES = 6
_PENDING_PREVIEW_LINES = 8
_SELF_CLOSING_BLOCKS = frozenset(("fence", "code_block", "hr", "html_block"))
_ELLIPSIS = "..."


def _truncate_to_display_width(line: str, max_width: int) -> str:
    """Truncate *line* so its terminal display width fits within *max_width*.

    Uses ``rich.cells.cell_len`` for CJK-aware column width measurement.
    """
    from rich.cells import cell_len

    if cell_len(line) <= max_width:
        return line
    ellipsis_width = cell_len(_ELLIPSIS)
    budget = max_width - ellipsis_width
    width = 0
    for i, ch in enumerate(line):
        width += cell_len(ch)
        if width > budget:
            return line[:i] + _ELLIPSIS
    return line


# Lazy-initialized markdown-it parser for incremental token commitment.
_md_parser: MarkdownIt | None = None


def _get_md_parser() -> MarkdownIt:
    global _md_parser
    if _md_parser is None:
        from markdown_it import MarkdownIt

        # Match the extensions used by the rendering path (utils/rich/markdown.py)
        # so that block boundaries are detected consistently.
        _md_parser = MarkdownIt().enable("strikethrough").enable("table")
    return _md_parser


def _estimate_tokens(text: str) -> float:
    """Estimate token count for mixed CJK/Latin text.

    Returns a **float** so that callers can accumulate across small chunks
    without per-chunk floor truncation (e.g. a 3-char ASCII chunk would
    yield 0 if truncated to int immediately, but 0.75 as float).

    Heuristics based on common BPE tokenizers (cl100k, o200k):
    - CJK ideographs: ~1.5 tokens per character (often split into 2-byte pieces)
    - Latin / ASCII: ~1 token per 4 characters (words average ~4 chars)
    """
    cjk = 0
    other = 0
    for ch in text:
        cp = ord(ch)
        if (
            0x4E00 <= cp <= 0x9FFF  # CJK Unified Ideographs
            or 0x3400 <= cp <= 0x4DBF  # CJK Extension A
            or 0xF900 <= cp <= 0xFAFF  # CJK Compatibility Ideographs
            or 0x3000 <= cp <= 0x303F  # CJK Symbols and Punctuation
            or 0xFF00 <= cp <= 0xFFEF  # Fullwidth Forms
        ):
            cjk += 1
        else:
            other += 1
    return cjk * 1.5 + other / 4


def _find_committed_boundary(text: str) -> int | None:
    """Return the character offset up to which *text* can be safely committed.

    Uses the incremental token commitment algorithm: parse text into block-level
    tokens via ``markdown-it-py``, confirm all blocks except the last one (which
    may be incomplete due to streaming truncation).

    Returns ``None`` when there are fewer than 2 blocks (nothing to confirm yet).
    """
    md = _get_md_parser()
    tokens = md.parse(text)

    # Collect only TOP-LEVEL block boundaries by tracking nesting depth.
    # Nested tokens (e.g. list_item_open inside bullet_list_open) must not be
    # treated as independent blocks — otherwise lists and blockquotes get split.
    block_maps: list[list[int]] = []
    depth = 0
    for t in tokens:
        if t.nesting == 1:
            if depth == 0 and t.map is not None:
                block_maps.append(t.map)
            depth += 1
        elif t.nesting == -1:
            depth -= 1
        elif depth == 0 and t.type in _SELF_CLOSING_BLOCKS and t.map is not None:
            block_maps.append(t.map)

    if len(block_maps) < 2:
        return None

    # Convert end-line number to character offset by scanning newlines.
    target_line = block_maps[-2][1]
    offset = 0
    for _ in range(target_line):
        offset = text.index("\n", offset) + 1
    return offset


def _tail_lines(text: str, n: int) -> str:
    """Extract the last *n* lines from *text* via reverse scanning (O(n))."""
    pos = len(text)
    for _ in range(n):
        pos = text.rfind("\n", 0, pos)
        if pos == -1:
            return text
    return text[pos + 1 :]


class _ContentBlock:
    """Streaming content block with incremental markdown commitment.

    For **composing** (``is_think=False``), confirmed markdown blocks are flushed
    to the terminal permanently via ``console.print()`` as they become complete,
    giving users real-time streaming output.  Only the unconfirmed tail remains
    in the transient Rich Live area.

    For **thinking** (``is_think=True``), content stays in the Live area as a
    scrolling preview until the block is finalized.
    """

    def __init__(self, is_think: bool):
        self.is_think = is_think
        self._spinner = Spinner("dots", "")
        self.raw_text = ""
        # Accumulated float estimate — avoids per-chunk int truncation.
        self._token_count: float = 0.0
        self._start_time = time.monotonic()
        # Incremental commitment state (composing only).
        self._committed_len = 0
        self._has_printed_bullet = False

    # -- Public API ----------------------------------------------------------

    def append(self, content: str) -> None:
        self.raw_text += content
        self._token_count += _estimate_tokens(content)
        # Block boundaries require newlines; skip parse for mid-line chunks.
        if not self.is_think and "\n" in content:
            self._flush_committed()

    def compose(self) -> RenderableType:
        """Render the transient Live area content."""
        pending = self._pending_text()

        # Thinking: always show spinner + preview.
        if self.is_think:
            spinner = self._compose_spinner()
            if not pending:
                return spinner
            preview = self._build_preview(pending)
            return Group(spinner, Text(preview, style="grey50 italic"))

        # Composing: always show spinner with elapsed time and token count.
        # Committed blocks are already printed permanently above.
        return self._compose_spinner()

    def compose_final(self) -> RenderableType:
        """Render the remaining uncommitted content when the block ends."""
        remaining = self._pending_text()
        if not remaining:
            return Text("")
        if self.is_think:
            return BulletColumns(
                Markdown(remaining, style="grey50 italic"),
                bullet_style="grey50",
            )
        return self._wrap_bullet(Markdown(remaining))

    def has_pending(self) -> bool:
        """Whether there is uncommitted content to flush."""
        return bool(self._pending_text())

    # -- Private -------------------------------------------------------------

    def _pending_text(self) -> str:
        return self.raw_text[self._committed_len :]

    def _wrap_bullet(self, renderable: RenderableType) -> BulletColumns:
        """First call gets the ``•`` bullet; subsequent calls get a space."""
        if self._has_printed_bullet:
            return BulletColumns(renderable, bullet=Text(" "))
        self._has_printed_bullet = True
        return BulletColumns(renderable)

    def _flush_committed(self) -> None:
        """Commit confirmed markdown blocks to permanent terminal output."""
        pending = self._pending_text()
        if not pending:
            return
        boundary = _find_committed_boundary(pending)
        if boundary is None:
            return
        committed_text = pending[:boundary]
        console.print(self._wrap_bullet(Markdown(committed_text)))
        self._committed_len += boundary

    def _compose_spinner(self) -> Spinner:
        elapsed = time.monotonic() - self._start_time
        label = "Thinking..." if self.is_think else "Composing..."
        elapsed_str = f"{int(elapsed)}s" if elapsed >= 1 else "<1s"
        count_str = f"{format_token_count(int(self._token_count))} tokens"

        self._spinner.text = Text.assemble(
            (label, ""),
            (f" {elapsed_str}", "grey50"),
            (f" · {count_str}", "grey50"),
        )
        return self._spinner

    def _build_preview(self, text: str) -> str:
        max_lines = _THINKING_PREVIEW_LINES if self.is_think else _PENDING_PREVIEW_LINES
        max_width = console.width - 2 if console.width else 78
        tail_text = _tail_lines(text, max_lines)
        lines = tail_text.split("\n")
        return "\n".join(_truncate_to_display_width(line, max_width) for line in lines)


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
                    bullet_style="green" if not sub_result.is_error else "dark_red",
                )
            )

        if self._result is not None:
            display = self._result.display
            idx = 0
            while idx < len(display):
                block = display[idx]
                if isinstance(block, DiffDisplayBlock):
                    # Collect consecutive same-file diff blocks
                    path = block.path
                    diff_blocks: list[DiffDisplayBlock] = []
                    while idx < len(display):
                        b = display[idx]
                        if not isinstance(b, DiffDisplayBlock) or b.path != path:
                            break
                        diff_blocks.append(b)
                        idx += 1
                    if any(b.is_summary for b in diff_blocks):
                        lines.append(render_diff_summary_panel(path, diff_blocks))
                    else:
                        hunks, added_total, removed_total = collect_diff_hunks(diff_blocks)
                        if hunks:
                            lines.append(render_diff_panel(path, hunks, added_total, removed_total))
                elif isinstance(block, BriefDisplayBlock):
                    style = "grey50" if not self._result.is_error else "dark_red"
                    if block.text:
                        lines.append(Markdown(block.text, style=style))
                    idx += 1
                elif isinstance(block, TodoDisplayBlock):
                    markdown = self._render_todo_markdown(block)
                    if markdown:
                        lines.append(Markdown(markdown, style="grey50"))
                    idx += 1
                elif isinstance(block, BackgroundTaskDisplayBlock):
                    lines.append(
                        Markdown(
                            (f"`{block.task_id}` [{block.status}] {block.description}"),
                            style="grey50",
                        )
                    )
                    idx += 1
                else:
                    idx += 1

        if self.finished:
            assert self._result is not None
            return BulletColumns(
                Group(*lines),
                bullet_style="green" if not self._result.is_error else "dark_red",
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
        self._btw_spinner: Spinner | None = None
        self._btw_question: str | None = None

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
        """Compose the live view display content.

        Approval and question panels are rendered first so they remain visible
        at the top of the terminal even when tool-call output is long enough
        to push content beyond the visible area.
        """
        blocks: list[RenderableType] = []
        # Approval/question panels first — highest visual priority.
        if self._current_approval_request_panel:
            blocks.append(self._current_approval_request_panel.render())
        if self._current_question_panel:
            blocks.append(self._current_question_panel.render())
        # Spinners or content + tool calls.
        if self._btw_spinner is not None:
            blocks.append(self._btw_spinner)
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
            case BtwBegin(question=question):
                truncated = (question[:40] + "...") if len(question) > 40 else question
                self._btw_question = question
                self._btw_spinner = Spinner("dots", f"Side question: {truncated}")
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
                            title=f"[dim]btw: {truncated_q}[/dim]",
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

        # Clear transient spinners to prevent visual residuals after interrupts
        self._mooning_spinner = None
        self._compacting_spinner = None
        self._mcp_loading_spinner = None
        self._btw_spinner = None

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
                self.refresh_soon()
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


class _BtwModalDelegate:
    """Modal delegate that fully replaces the prompt line with a /btw panel.

    Attached via ``prompt_session.attach_modal()`` so that the prompt message
    renderer skips the separator and prompt label, showing only the btw panel.
    """

    modal_priority = 5  # above running prompt (0), below question (10) and approval (20)

    def __init__(self, *, on_dismiss: Callable[[], None]) -> None:
        self._on_dismiss = on_dismiss
        self._question: str = ""
        self._response: str | None = None
        self._error: str | None = None
        self._is_loading: bool = True
        self._spinner: Spinner = Spinner("dots", "Answering...", style="yellow")
        self._streaming_text: str = ""  # accumulated text during streaming

    def append_text(self, chunk: str) -> None:
        """Append a streaming text chunk (called from the btw runner)."""
        self._streaming_text += chunk

    def set_result(self, response: str | None, error: str | None) -> None:
        self._response = response
        self._error = error
        self._is_loading = False

    def render_running_prompt_body(self, columns: int) -> ANSI:
        parts: list[RenderableType] = []
        parts.append(Text(self._question, style="dim"))
        if self._is_loading:
            parts.append(Text(""))
            if self._streaming_text:
                # Show streaming text as it arrives
                parts.append(Markdown(self._streaming_text))
                parts.append(Text(""))
                parts.append(self._spinner)
            else:
                parts.append(self._spinner)
        elif self._error:
            parts.append(Text(""))
            parts.append(Text(self._error, style="red"))
            parts.append(Text(""))
            parts.append(Text("Escape to dismiss", style="dim"))
        elif self._response:
            parts.append(Text(""))
            parts.append(Markdown(self._response))
            parts.append(Text(""))
            parts.append(Text("Escape to dismiss", style="dim"))
        else:
            parts.append(Text(""))
            parts.append(Text("No response received.", style="dim"))
            parts.append(Text(""))
            parts.append(Text("Escape to dismiss", style="dim"))
        panel = Panel(
            Group(*parts),
            title="[bold]btw[/bold]",
            border_style="grey50",
            padding=(0, 1),
        )
        body = render_to_ansi(panel, columns=columns).rstrip("\n")
        return ANSI(body)

    def running_prompt_placeholder(self) -> str | None:
        return None

    def running_prompt_allows_text_input(self) -> bool:
        return False

    def running_prompt_hides_input_buffer(self) -> bool:
        return True

    def running_prompt_accepts_submission(self) -> bool:
        return False

    def should_handle_running_prompt_key(self, key: str) -> bool:
        if self._is_loading:
            return key in {"escape", "c-c", "c-d"}
        return key in {"escape", "enter", "space", "c-c", "c-d"}

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        self._on_dismiss()


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
        # Clear the input buffer so the /btw command text doesn't
        # reappear when the modal is dismissed.
        buf = self._prompt_session._session.default_buffer  # pyright: ignore[reportPrivateUsage]
        if buf.text:
            buf.set_document(Document(), bypass_readonly=True)
        modal = _BtwModalDelegate(on_dismiss=self._dismiss_btw)
        modal._question = question  # pyright: ignore[reportPrivateUsage]
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
