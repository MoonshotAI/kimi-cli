# pyright: reportUnusedClass=false
"""Renderable block components for the streaming agent view.

Each block receives data via method calls and produces Rich renderables.
They have no knowledge of the event loop or prompt_toolkit.
"""

from __future__ import annotations

import json
import math
import time
from collections import deque
from typing import TYPE_CHECKING, Any, NamedTuple, cast

if TYPE_CHECKING:
    from markdown_it import MarkdownIt

import streamingjson  # type: ignore[reportMissingTypeStubs]
from rich.console import Group, RenderableType
from rich.spinner import Spinner
from rich.style import Style
from rich.text import Text

from kimi_cli.soul import format_token_count
from kimi_cli.tools import extract_key_argument
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.datetime import format_elapsed
from kimi_cli.utils.rich.columns import BulletColumns
from kimi_cli.utils.rich.diff_render import (
    collect_diff_hunks,
    render_diff_panel,
    render_diff_summary_panel,
)
from kimi_cli.utils.rich.markdown import Markdown
from kimi_cli.wire.types import (
    BackgroundTaskDisplayBlock,
    BriefDisplayBlock,
    DiffDisplayBlock,
    Notification,
    StatusUpdate,
    TodoDisplayBlock,
    ToolCall,
    ToolCallPart,
    ToolResult,
    ToolReturnValue,
)

_ELLIPSIS = "..."
_THINKING_PREVIEW_LINES = 6
_SELF_CLOSING_BLOCKS = frozenset(("fence", "code_block", "hr", "html_block"))
MAX_SUBAGENT_TOOL_CALLS_TO_SHOW = 4

# Animated bullet frames shown after the "Thinking" label. Dots grow in
# from the left, reach three, then drain out from the left — a continuous
# rightward flow that loops every ``_BULLET_FRAME_INTERVAL * len(frames)``.
_BULLET_FRAMES = (".  ", ".. ", "...", " ..", "  .", "   ")
_BULLET_FRAME_INTERVAL = 0.13  # seconds per frame


def _bullet_frame_for(elapsed: float) -> str:
    """Select the current bullet frame from wall-clock elapsed time."""
    idx = int(elapsed / _BULLET_FRAME_INTERVAL) % len(_BULLET_FRAMES)
    return _BULLET_FRAMES[idx]


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

    For **thinking** (``is_think=True``), the default behavior is to keep the
    raw reasoning text only for token accounting and never render it.  The
    Live area shows a compact ``Thinking`` label with an animated bullet
    sequence, elapsed time, token count, and a live tokens/second pulse;
    when the block ends, a one-liner ``Thought for Xs · N tokens`` is
    committed to history in grey italics.

    When ``show_thinking_stream=True``, the legacy behavior is restored: the
    Live area shows a ``Thinking...`` spinner above a 6-line scrolling preview
    of the raw reasoning text, and the full reasoning markdown is committed
    to history when the block ends.
    """

    def __init__(self, is_think: bool, *, show_thinking_stream: bool = False):
        self.is_think = is_think
        self._show_thinking_stream = show_thinking_stream
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
        """Render the transient Live area content.

        Thinking mode shows the italic ``Thinking`` label with animated
        bullets; composing mode shows the dots spinner over the
        uncommitted markdown tail.  When ``show_thinking_stream`` is enabled,
        thinking mode falls back to the legacy ``Thinking...`` spinner stacked
        above a 6-line scrolling preview of the raw reasoning text.
        """
        if self.is_think:
            if self._show_thinking_stream:
                return self._compose_thinking_stream()
            return self._compose_thinking()
        return self._compose_spinner()

    def compose_final(self) -> RenderableType:
        """Render the remaining uncommitted content when the block ends."""
        if self.is_think:
            if self._show_thinking_stream:
                remaining = self._pending_text()
                if not remaining:
                    return Text("")
                return BulletColumns(
                    Markdown(remaining, style="grey50 italic"),
                    bullet_style="grey50",
                )
            elapsed_str = format_elapsed(time.monotonic() - self._start_time)
            count_str = format_token_count(int(self._token_count))
            return Text(
                f"Thought for {elapsed_str} · {count_str} tokens",
                style="grey50 italic",
            )
        remaining = self._pending_text()
        if not remaining:
            return Text("")
        return self._wrap_bullet(Markdown(remaining))

    def has_pending(self) -> bool:
        """Whether there is uncommitted content to flush."""
        # Thinking blocks always commit a final trace line if any content
        # was received, so gate on raw_text rather than uncommitted length.
        if self.is_think:
            return bool(self.raw_text)
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
        elapsed_str = format_elapsed(elapsed)
        count_str = f"{format_token_count(int(self._token_count))} tokens"

        self._spinner.text = Text.assemble(
            ("Composing...", ""),
            (f" {elapsed_str}", "grey50"),
            (f" · {count_str}", "grey50"),
        )
        return self._spinner

    def _compose_thinking_stream(self) -> RenderableType:
        """Legacy 'Thinking...' spinner stacked over a 6-line scrolling preview."""
        spinner = self._compose_thinking_spinner()
        pending = self._pending_text()
        if not pending:
            return spinner
        preview = self._build_preview(pending)
        return Group(spinner, Text(preview, style="grey50 italic"))

    def _compose_thinking_spinner(self) -> Spinner:
        """Legacy 'Thinking...' spinner header used by the stream-mode preview."""
        elapsed = time.monotonic() - self._start_time
        elapsed_str = format_elapsed(elapsed)
        count_str = f"{format_token_count(int(self._token_count))} tokens"
        self._spinner.text = Text.assemble(
            ("Thinking...", ""),
            (f" {elapsed_str}", "grey50"),
            (f" · {count_str}", "grey50"),
        )
        return self._spinner

    def _build_preview(self, text: str) -> str:
        """Tail-trim *text* to the last ``_THINKING_PREVIEW_LINES`` and clamp width."""
        max_width = console.width - 2 if console.width else 78
        tail_text = _tail_lines(text, _THINKING_PREVIEW_LINES)
        lines = tail_text.split("\n")
        return "\n".join(_truncate_to_display_width(line, max_width) for line in lines)

    def _compose_thinking(self) -> Text:
        """Render the thinking line: italic Thinking + bullets + metadata."""
        elapsed = time.monotonic() - self._start_time
        elapsed_str = format_elapsed(elapsed)
        tokens_int = int(self._token_count)
        count_str = f"{format_token_count(tokens_int)} tokens"
        frame = _bullet_frame_for(elapsed)

        parts: list[tuple[str, str | Style]] = [
            ("Thinking", "italic"),
            (f" {frame}", "cyan"),
            (f"  {elapsed_str}", "grey50"),
            (f" · {count_str}", "grey50"),
        ]

        # Live tok/s pulse — a real heartbeat signal that confirms the model
        # is still streaming even when the raw content is hidden.
        if elapsed > 0.5 and tokens_int > 0:
            rate = int(tokens_int / elapsed)
            if rate > 0:
                parts.append((f" · {rate} tok/s", "grey50"))

        return Text.assemble(*parts)


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
            bounded = max(0.0, min(self._context_usage, 1.0))
            bar_width = 10
            filled = math.ceil(bounded * bar_width) if bounded > 0 else 0
            pct = int(bounded * 100)
            if bounded >= 0.85:
                color = "red"
            elif bounded >= 0.70:
                color = "yellow"
            else:
                color = "green"
            self.text = Text("Context ", justify="right")
            self.text.append("█" * filled, style=color)
            self.text.append("░" * (bar_width - filled), style=f"dim {color}")
            self.text.append(f" {pct}%", style=color)
            if self._max_context_tokens > 0:
                used = format_token_count(self._context_tokens)
                total = format_token_count(self._max_context_tokens)
                self.text.append(f" ({used}/{total})")
