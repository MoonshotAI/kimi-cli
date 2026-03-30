"""Unified diff rendering for CLI tool results and approval panels.

All diff rendering flows through this module:
- ``render_diff_panel``  — full diff with Panel, Table, background colors (tool results & pager)
- ``render_diff_preview`` — compact changed-lines-only preview (approval panel)
- ``collect_diff_hunks``  — shared data preparation from DiffDisplayBlocks
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from enum import Enum, auto

from rich.console import RenderableType
from rich.panel import Panel
from rich.style import Style
from rich.table import Table
from rich.text import Text

from kimi_cli.tools.display import DiffDisplayBlock
from kimi_cli.utils.rich.syntax import KimiSyntax

# ---------------------------------------------------------------------------
# Style constants
# ---------------------------------------------------------------------------

# Note: These are evaluated lazily to avoid circular imports
# and to support runtime theme switching.
# Colors are retrieved from theme.py for consistency.


def _get_theme_colors():
    """Get theme colors, importing lazily to avoid circular imports."""
    from kimi_cli.ui.shell.theme import get_theme_colors

    return get_theme_colors()


def _get_add_bg() -> Style:
    """Get background style for added lines."""
    return Style(bgcolor=_get_theme_colors().diff_add_bg)


def _get_del_bg() -> Style:
    """Get background style for deleted lines."""
    return Style(bgcolor=_get_theme_colors().diff_del_bg)


def _get_add_hl() -> Style:
    """Get highlight style for inline additions."""
    return Style(bgcolor=_get_theme_colors().diff_add_hl)


def _get_del_hl() -> Style:
    """Get highlight style for inline deletions."""
    return Style(bgcolor=_get_theme_colors().diff_del_hl)


_INLINE_DIFF_MIN_RATIO = 0.5  # skip inline diff when lines are too dissimilar

MAX_PREVIEW_CHANGED_LINES = 6


# ---------------------------------------------------------------------------
# Data model — parsed diff lines
# ---------------------------------------------------------------------------


class DiffLineKind(Enum):
    CONTEXT = auto()
    ADD = auto()
    DELETE = auto()


@dataclass(slots=True)
class DiffLine:
    kind: DiffLineKind
    old_num: int  # 0 means "not applicable" (e.g. added line has no old number)
    new_num: int  # 0 means "not applicable" (e.g. deleted line has no new number)
    code: str
    content: Text | None = None  # filled after highlighting
    is_inline_paired: bool = False  # True if this line was paired for inline diff


# ---------------------------------------------------------------------------
# Core: build DiffLines directly from old_text / new_text via SequenceMatcher
# ---------------------------------------------------------------------------


def _build_diff_lines(
    old_text: str,
    new_text: str,
    old_start: int,
    new_start: int,
    n_context: int = 3,
) -> list[list[DiffLine]]:
    """Build grouped DiffLine hunks directly from old/new text.

    Returns a list of hunks, where each hunk is a list of DiffLine objects.
    This replaces the format_unified_diff → parse roundtrip.
    """
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    matcher = SequenceMatcher(None, old_lines, new_lines, autojunk=False)

    hunks: list[list[DiffLine]] = []
    for group in matcher.get_grouped_opcodes(n=n_context):
        hunk: list[DiffLine] = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for k in range(i2 - i1):
                    hunk.append(
                        DiffLine(
                            kind=DiffLineKind.CONTEXT,
                            old_num=old_start + i1 + k,
                            new_num=new_start + j1 + k,
                            code=old_lines[i1 + k],
                        )
                    )
            elif tag == "delete":
                for k in range(i2 - i1):
                    hunk.append(
                        DiffLine(
                            kind=DiffLineKind.DELETE,
                            old_num=old_start + i1 + k,
                            new_num=0,
                            code=old_lines[i1 + k],
                        )
                    )
            elif tag == "insert":
                for k in range(j2 - j1):
                    hunk.append(
                        DiffLine(
                            kind=DiffLineKind.ADD,
                            old_num=0,
                            new_num=new_start + j1 + k,
                            code=new_lines[j1 + k],
                        )
                    )
            elif tag == "replace":
                for k in range(i2 - i1):
                    hunk.append(
                        DiffLine(
                            kind=DiffLineKind.DELETE,
                            old_num=old_start + i1 + k,
                            new_num=0,
                            code=old_lines[i1 + k],
                        )
                    )
                for k in range(j2 - j1):
                    hunk.append(
                        DiffLine(
                            kind=DiffLineKind.ADD,
                            old_num=0,
                            new_num=new_start + j1 + k,
                            code=new_lines[j1 + k],
                        )
                    )
        if hunk:
            hunks.append(hunk)
    return hunks


# ---------------------------------------------------------------------------
# Syntax highlighting & inline diff
# ---------------------------------------------------------------------------


def _make_highlighter(path: str) -> KimiSyntax:
    """Create a KimiSyntax instance for highlighting code by file extension."""
    ext = path.rsplit(".", 1)[-1] if "." in path else ""
    return KimiSyntax("", ext if ext else "text")


def _highlight(highlighter: KimiSyntax, code: str) -> Text:
    t = highlighter.highlight(code)
    t.rstrip()
    return t


def _apply_inline_diff(
    highlighter: KimiSyntax,
    del_lines: list[DiffLine],
    add_lines: list[DiffLine],
) -> None:
    """Pair delete/add lines and apply word-level inline diff highlighting.

    Modifies DiffLine.content in place for paired lines.
    """
    paired = min(len(del_lines), len(add_lines))
    for j in range(paired):
        old_code = del_lines[j].code
        new_code = add_lines[j].code
        sm = SequenceMatcher(None, old_code, new_code)
        if sm.ratio() < _INLINE_DIFF_MIN_RATIO:
            continue
        old_text = _highlight(highlighter, old_code)
        new_text = _highlight(highlighter, new_code)
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op in ("delete", "replace"):
                old_text.stylize(_get_del_hl(), i1, i2)
            if op in ("insert", "replace"):
                new_text.stylize(_get_add_hl(), j1, j2)
        del_lines[j].content = old_text
        del_lines[j].is_inline_paired = True
        add_lines[j].content = new_text
        add_lines[j].is_inline_paired = True


def _highlight_hunk(highlighter: KimiSyntax, hunk: list[DiffLine]) -> None:
    """Highlight all lines in a hunk, applying inline diff for paired -/+ blocks."""
    # Clear cached content to ensure theme colors are re-applied
    for dl in hunk:
        dl.content = None

    # First pass: find consecutive -/+ blocks and apply inline diff
    i = 0
    while i < len(hunk):
        if hunk[i].kind == DiffLineKind.DELETE:
            del_start = i
            while i < len(hunk) and hunk[i].kind == DiffLineKind.DELETE:
                i += 1
            add_start = i
            while i < len(hunk) and hunk[i].kind == DiffLineKind.ADD:
                i += 1
            _apply_inline_diff(
                highlighter,
                hunk[del_start:add_start],
                hunk[add_start:i],
            )
        else:
            i += 1

    # Second pass: highlight any lines not yet highlighted by inline diff
    for dl in hunk:
        if dl.content is None:
            dl.content = _highlight(highlighter, dl.code)


# ---------------------------------------------------------------------------
# Shared header builder
# ---------------------------------------------------------------------------


def _build_diff_header(path: str, added: int, removed: int) -> Text:
    """Build the file header text: stats + path."""
    header = Text()
    if added > 0:
        header.append(f"+{added} ", style="bold green")
    if removed > 0:
        header.append(f"-{removed} ", style="bold red")
    header.append(path)
    return header


# ---------------------------------------------------------------------------
# Public: collect hunks from DiffDisplayBlocks
# ---------------------------------------------------------------------------


def collect_diff_hunks(
    blocks: list[DiffDisplayBlock],
) -> tuple[list[list[DiffLine]], int, int]:
    """Build parsed DiffLine hunks and stats from a list of same-file DiffDisplayBlocks.

    Returns:
        (hunks, added_total, removed_total) where each hunk is a list of DiffLine.
    """
    all_hunks: list[list[DiffLine]] = []
    added = 0
    removed = 0
    for b in blocks:
        block_hunks = _build_diff_lines(
            b.old_text,
            b.new_text,
            b.old_start,
            b.new_start,
        )
        for hunk in block_hunks:
            for dl in hunk:
                if dl.kind == DiffLineKind.ADD:
                    added += 1
                elif dl.kind == DiffLineKind.DELETE:
                    removed += 1
            all_hunks.append(hunk)
    return all_hunks, added, removed


# ---------------------------------------------------------------------------
# Public: full diff panel (tool results & pager)
# ---------------------------------------------------------------------------


def render_diff_panel(
    path: str,
    hunks: list[list[DiffLine]],
    added: int,
    removed: int,
) -> RenderableType:
    """Render a diff as a bordered Panel with line numbers, background colors,
    syntax highlighting, and inline change markers."""
    title = Text()
    title.append(" ")
    title.append_text(_build_diff_header(path, added, removed))
    title.append(" ")

    highlighter = _make_highlighter(path)
    for hunk in hunks:
        _highlight_hunk(highlighter, hunk)

    # Compute line number column width
    max_ln = 0
    for hunk in hunks:
        for dl in hunk:
            max_ln = max(max_ln, dl.old_num, dl.new_num)
    num_width = max(len(str(max_ln)), 2)

    table = Table(
        show_header=False,
        box=None,
        padding=(0, 0),
        show_edge=False,
        expand=True,
    )
    table.add_column(justify="right", width=num_width, no_wrap=True)
    table.add_column(width=3, no_wrap=True)
    table.add_column(ratio=1)

    for hunk_idx, hunk in enumerate(hunks):
        if hunk_idx > 0:
            table.add_row(Text("⋮", style="dim"), Text(""), Text(""))

        for dl in hunk:
            assert dl.content is not None
            if dl.kind == DiffLineKind.ADD:
                bg_style = _get_add_bg()
                table.add_row(
                    Text(str(dl.new_num)),
                    Text(" + ", style="green"),
                    dl.content,
                    style=bg_style,
                )
            elif dl.kind == DiffLineKind.DELETE:
                bg_style = _get_del_bg()
                table.add_row(
                    Text(str(dl.old_num)),
                    Text(" - ", style="red"),
                    dl.content,
                    style=bg_style,
                )
            else:
                table.add_row(
                    Text(str(dl.new_num), style="dim"),
                    Text("   "),
                    dl.content,
                    style=Style(),
                )

    return Panel(
        table,
        title=title,
        title_align="left",
        border_style="dim",
        padding=(0, 1),
        style=Style(),
    )


# ---------------------------------------------------------------------------
# Public: compact preview (approval panels)
# ---------------------------------------------------------------------------


def render_diff_preview(
    path: str,
    hunks: list[list[DiffLine]],
    added: int,
    removed: int,
    max_lines: int = MAX_PREVIEW_CHANGED_LINES,
) -> tuple[list[RenderableType], int]:
    """Render a compact diff preview showing only changed lines (no context).

    Returns:
        (renderables, remaining_count) — list of Rich renderables and number of
        changed lines not shown.
    """
    highlighter = _make_highlighter(path)
    for hunk in hunks:
        _highlight_hunk(highlighter, hunk)

    # Collect only changed lines across all hunks
    changed: list[DiffLine] = []
    for hunk in hunks:
        for dl in hunk:
            if dl.kind != DiffLineKind.CONTEXT:
                changed.append(dl)

    total = len(changed)
    shown = changed[:max_lines]
    remaining = total - len(shown)

    # Compute line number width from shown lines
    max_ln = max(
        (dl.old_num if dl.kind == DiffLineKind.DELETE else dl.new_num for dl in shown),
        default=0,
    )
    num_width = max(len(str(max_ln)), 2)

    result: list[RenderableType] = [_build_diff_header(path, added, removed)]

    if shown:
        # Use Table to ensure background color fills entire row (like render_diff_panel)
        table = Table(
            show_header=False,
            box=None,
            padding=(0, 0),
            show_edge=False,
            expand=True,
        )
        table.add_column(justify="right", width=num_width, no_wrap=True)
        table.add_column(width=3, no_wrap=True)
        table.add_column(ratio=1)

        for dl in shown:
            assert dl.content is not None
            bg_style = _get_add_bg() if dl.kind == DiffLineKind.ADD else _get_del_bg()
            line_num = dl.new_num if dl.kind == DiffLineKind.ADD else dl.old_num
            sign = " + " if dl.kind == DiffLineKind.ADD else " - "
            sign_style = "green" if dl.kind == DiffLineKind.ADD else "red"
            table.add_row(
                Text(str(line_num)),
                Text(sign, style=sign_style),
                dl.content,
                style=bg_style,
            )

        result.append(table)

    if remaining > 0:
        result.append(Text(f"... {remaining} more lines (ctrl-e to expand)", style="dim italic"))

    return result, remaining
