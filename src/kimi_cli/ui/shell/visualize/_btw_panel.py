# pyright: reportUnusedClass=false
"""BTW side question modal panel.

Renders the /btw overlay that replaces the prompt line, with:
- Left-aligned title showing state + elapsed time
- Q/A visual separation
- Scrolling with ↑/↓ for long responses
- Auto-scroll (tail mode) during streaming
- Compact hint for short answers
"""

from __future__ import annotations

from collections.abc import Callable

from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyPressEvent
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.spinner import Spinner
from rich.text import Text

from kimi_cli.ui.shell.console import render_to_ansi
from kimi_cli.ui.shell.visualize._blocks import Markdown

_BTW_MAX_VISIBLE_LINES = 20
"""Max content lines shown in btw panel before scrolling kicks in."""

_BTW_SHORT_ANSWER_LINES = 3
"""Answers with ≤ this many lines get simplified hints."""


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
        self._spinner: Spinner = Spinner("dots", style="yellow")
        self._streaming_text: str = ""
        self._scroll_offset: int = 0
        self._auto_scroll: bool = True  # tail mode during streaming
        self._start_time: float = 0.0

    def set_start_time(self, t: float) -> None:
        self._start_time = t

    def append_text(self, chunk: str) -> None:
        """Append a streaming text chunk (called from the btw runner)."""
        self._streaming_text += chunk

    def set_result(self, response: str | None, error: str | None) -> None:
        self._response = response
        self._error = error
        self._is_loading = False
        self._scroll_offset = 0
        self._auto_scroll = False

    # -- Title ---------------------------------------------------------------

    def _build_title(self) -> str:
        import time

        if self._is_loading:
            elapsed = int(time.monotonic() - self._start_time) if self._start_time else 0
            char_count = len(self._streaming_text)
            if char_count > 0:
                return f"[bold]btw[/bold] [dim]· answering {elapsed}s · {char_count} chars[/dim]"
            return f"[bold]btw[/bold] [dim]· answering {elapsed}s[/dim]"
        if self._error:
            return "[bold]btw[/bold] [dim]· error[/dim]"
        return "[bold]btw[/bold]"

    # -- Render --------------------------------------------------------------

    def render_running_prompt_body(self, columns: int) -> ANSI:
        parts: list[RenderableType] = []

        # Q line — bold cyan with prefix
        q_text = Text()
        q_text.append("Q: ", style="bold cyan")
        q_text.append(self._question)
        parts.append(q_text)
        # Separator between Q and A
        parts.append(Text("─" * max(1, columns - 6), style="grey50"))

        if self._is_loading:
            if self._streaming_text:
                parts.append(Markdown(self._streaming_text))
                parts.append(Text(""))
                parts.append(self._spinner)
            else:
                parts.append(self._spinner)
        elif self._error:
            parts.append(Text(self._error, style="red"))
        elif self._response:
            parts.append(Markdown(self._response))
        else:
            parts.append(Text("No response received.", style="dim"))

        panel = Panel(
            Group(*parts),
            title=self._build_title(),
            title_align="left",
            border_style="grey50",
            padding=(0, 1),
        )

        full = render_to_ansi(panel, columns=columns).rstrip("\n")
        lines = full.split("\n")
        total = len(lines)

        # --- No scroll needed ---
        if total <= _BTW_MAX_VISIBLE_LINES:
            if not self._is_loading and total > 2:
                answer_lines = total - 4
                if answer_lines <= _BTW_SHORT_ANSWER_LINES:
                    hint = "  Escape to dismiss"
                else:
                    hint = "  ↑/↓ scroll · Escape dismiss"
                lines.insert(-1, hint)
            return ANSI("\n".join(lines))

        # --- Scroll mode ---
        border_top = lines[0]
        border_bottom = lines[-1]
        content = lines[1:-1]

        # Auto-scroll: during streaming, follow the bottom
        if self._auto_scroll:
            max_content = _BTW_MAX_VISIBLE_LINES - 3
            self._scroll_offset = max(0, len(content) - max_content)

        max_content = _BTW_MAX_VISIBLE_LINES - 3
        max_offset = max(0, len(content) - max_content)
        self._scroll_offset = min(self._scroll_offset, max_offset)
        start = self._scroll_offset
        visible = content[start : start + max_content]

        above = start
        below = max_offset - start
        hint_parts: list[str] = []
        if above > 0:
            hint_parts.append(f"↑ {above} above")
        if below > 0:
            hint_parts.append(f"↓ {below} below")
        hint_parts.append("↑/↓ scroll · Escape dismiss")
        hint_line = f"  {'  ·  '.join(hint_parts)}"

        result = [border_top, *visible, hint_line, border_bottom]
        return ANSI("\n".join(result))

    # -- Protocol ------------------------------------------------------------

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
            return key in {"escape", "c-c", "c-d", "up", "down"}
        return key in {"escape", "enter", "space", "c-c", "c-d", "up", "down"}

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        if key in {"up", "down"}:
            self._auto_scroll = False  # user took manual control
            if key == "up":
                self._scroll_offset = max(0, self._scroll_offset - 3)
            else:
                self._scroll_offset += 3
            return
        self._on_dismiss()
