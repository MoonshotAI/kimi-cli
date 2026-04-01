"""Tests for kimi_cli.utils.rich.diff_render — unified diff rendering."""

from __future__ import annotations

import pytest
from rich.console import Console
from rich.text import Text

from kimi_cli.tools.display import DiffDisplayBlock
from kimi_cli.utils.diff import _build_diff_blocks_sync as build_diff_blocks
from kimi_cli.utils.rich.diff_render import (
    DiffLineKind,
    _build_diff_header,
    _build_diff_lines,
    _highlight_hunk,
    _make_highlighter,
    collect_diff_hunks,
    render_diff_panel,
    render_diff_preview,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _render_to_text(renderable) -> str:
    """Render a Rich renderable to plain text for assertion."""
    console = Console(width=120, force_terminal=True, color_system=None)
    with console.capture() as cap:
        console.print(renderable, end="")
    return cap.get()


def _make_block(
    path: str = "test.py",
    old_text: str = "",
    new_text: str = "",
    old_start: int = 1,
    new_start: int = 1,
) -> DiffDisplayBlock:
    return DiffDisplayBlock(
        path=path,
        old_text=old_text,
        new_text=new_text,
        old_start=old_start,
        new_start=new_start,
    )


def _collect(old_text: str, new_text: str, **kw):
    """Shortcut: make a block and collect hunks."""
    blocks = [_make_block(old_text=old_text, new_text=new_text, **kw)]
    return collect_diff_hunks(blocks)


# ---------------------------------------------------------------------------
# _build_diff_lines
# ---------------------------------------------------------------------------


class TestBuildDiffLines:
    def test_replace_produces_context_delete_add(self) -> None:
        hunks = _build_diff_lines("hello\nworld", "hello\nearth", 1, 1)
        assert len(hunks) == 1
        kinds = [dl.kind for dl in hunks[0]]
        assert DiffLineKind.CONTEXT in kinds
        assert DiffLineKind.DELETE in kinds
        assert DiffLineKind.ADD in kinds

    def test_line_numbers_start_from_given_offset(self) -> None:
        hunks = _build_diff_lines("a\nb", "a\nc", old_start=10, new_start=20)
        ctx = [dl for dl in hunks[0] if dl.kind == DiffLineKind.CONTEXT]
        assert ctx[0].old_num == 10
        assert ctx[0].new_num == 20

    def test_delete_has_old_num_only(self) -> None:
        hunks = _build_diff_lines("a\nb\nc", "a\nc", 1, 1)
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        assert deletes[0].old_num > 0
        assert deletes[0].new_num == 0

    def test_insert_has_new_num_only(self) -> None:
        hunks = _build_diff_lines("a\nc", "a\nb\nc", 1, 1)
        inserts = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert inserts[0].old_num == 0
        assert inserts[0].new_num > 0

    def test_empty_old_text_all_inserts(self) -> None:
        hunks = _build_diff_lines("", "line1\nline2\nline3", 1, 1)
        assert all(dl.kind == DiffLineKind.ADD for dl in hunks[0])

    def test_empty_new_text_all_deletes(self) -> None:
        hunks = _build_diff_lines("line1\nline2\nline3", "", 1, 1)
        assert all(dl.kind == DiffLineKind.DELETE for dl in hunks[0])

    def test_identical_text_no_hunks(self) -> None:
        assert _build_diff_lines("same\ntext", "same\ntext", 1, 1) == []

    def test_both_empty_no_hunks(self) -> None:
        assert _build_diff_lines("", "", 1, 1) == []

    def test_multiple_hunks_from_distant_changes(self) -> None:
        lines = [f"line {i}" for i in range(20)]
        old_text = "\n".join(lines)
        new_lines = lines.copy()
        new_lines[1] = "CHANGED 1"
        new_lines[18] = "CHANGED 18"
        hunks = _build_diff_lines(old_text, "\n".join(new_lines), 1, 1)
        assert len(hunks) == 2


# ---------------------------------------------------------------------------
# _highlight_hunk — inline diff pairing
# ---------------------------------------------------------------------------


class TestHighlightHunk:
    def test_all_lines_get_content(self) -> None:
        hunks = _build_diff_lines("a\nb", "a\nc", 1, 1)
        _highlight_hunk(_make_highlighter("test.py"), hunks[0])
        for dl in hunks[0]:
            assert isinstance(dl.content, Text)

    def test_inline_diff_pairing(self) -> None:
        hunks = _build_diff_lines(
            "def hello(name):\n    pass",
            "def hello(user_name):\n    pass",
            1,
            1,
        )
        _highlight_hunk(_make_highlighter("test.py"), hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].is_inline_paired
        assert adds[0].is_inline_paired

    def test_dissimilar_lines_not_paired(self) -> None:
        hunks = _build_diff_lines(
            "completely different line",
            "import os\nimport sys\nimport json",
            1,
            1,
        )
        _highlight_hunk(_make_highlighter("test.py"), hunks[0])
        assert not any(dl.is_inline_paired for dl in hunks[0])

    def test_unequal_block_sizes_partial_pairing(self) -> None:
        """3 deletes + 2 adds: first 2 paired, 3rd delete unpaired."""
        old = "line_a\nline_b\nline_c"
        new = "line_A\nline_B"
        hunks = _build_diff_lines(old, new, 1, 1)
        _highlight_hunk(_make_highlighter("test.py"), hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert len(deletes) == 3
        assert len(adds) == 2
        # First 2 paired
        assert deletes[0].is_inline_paired
        assert deletes[1].is_inline_paired
        assert adds[0].is_inline_paired
        assert adds[1].is_inline_paired
        # 3rd delete not paired
        assert not deletes[2].is_inline_paired

    def test_inline_diff_with_tabs(self) -> None:
        """Inline highlight offsets must account for tab-to-space expansion."""
        old = "\told_value = 1"
        new = "\tnew_value = 2"
        hunks = _build_diff_lines(old, new, 1, 1)
        hl = _make_highlighter("test.py")
        _highlight_hunk(hl, hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].is_inline_paired
        assert adds[0].is_inline_paired
        assert deletes[0].content is not None
        assert adds[0].content is not None
        del_plain = deletes[0].content.plain
        add_plain = adds[0].content.plain
        assert "old_value" in del_plain
        assert "new_value" in add_plain
        # Verify the highlight spans cover the actual changed words,
        # not characters shifted by unexpanded-tab offsets.
        from kimi_cli.utils.rich.diff_render import get_diff_colors

        colors = get_diff_colors()
        assert deletes[0].content is not None
        assert adds[0].content is not None
        del_hl_spans = [
            (s.start, s.end) for s in deletes[0].content.spans if s.style == colors.del_hl
        ]
        add_hl_spans = [(s.start, s.end) for s in adds[0].content.spans if s.style == colors.add_hl]
        # The highlighted region in the old line must cover "old" (from old_value)
        del_highlighted = "".join(del_plain[s:e] for s, e in del_hl_spans)
        add_highlighted = "".join(add_plain[s:e] for s, e in add_hl_spans)
        assert "old" in del_highlighted, f"expected 'old' in highlighted text: {del_highlighted!r}"
        assert "new" in add_highlighted, f"expected 'new' in highlighted text: {add_highlighted!r}"

    def test_inline_diff_tab_to_spaces(self) -> None:
        """A change from tab to spaces should be highlighted as an inline diff."""
        old = "\tvalue = 1"
        new = "    value = 1"
        hunks = _build_diff_lines(old, new, 1, 1)
        hl = _make_highlighter("test.py")
        _highlight_hunk(hl, hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].is_inline_paired
        assert adds[0].is_inline_paired
        # The inline highlight should cover the indentation region where
        # tab vs spaces differ.
        from kimi_cli.utils.rich.diff_render import get_diff_colors

        colors = get_diff_colors()
        assert deletes[0].content is not None
        assert adds[0].content is not None
        del_hl_spans = [
            (s.start, s.end) for s in deletes[0].content.spans if s.style == colors.del_hl
        ]
        add_hl_spans = [(s.start, s.end) for s in adds[0].content.spans if s.style == colors.add_hl]
        # There must be highlight spans — the whitespace change should not be invisible
        assert del_hl_spans, "tab indentation should be highlighted in deleted line"
        assert add_hl_spans, "space indentation should be highlighted in added line"

    def test_inline_diff_mixed_tab_and_space(self) -> None:
        """Inline highlight must handle a tab adjacent to a literal space."""
        old = "a\t b"
        new = "a   b"
        hunks = _build_diff_lines(old, new, 1, 1)
        hl = _make_highlighter("test.txt")
        _highlight_hunk(hl, hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].is_inline_paired
        assert adds[0].is_inline_paired
        from kimi_cli.utils.rich.diff_render import get_diff_colors

        colors = get_diff_colors()
        assert deletes[0].content is not None
        assert adds[0].content is not None
        del_hl_spans = [
            (s.start, s.end) for s in deletes[0].content.spans if s.style == colors.del_hl
        ]
        add_hl_spans = [(s.start, s.end) for s in adds[0].content.spans if s.style == colors.add_hl]
        # The tab+space region in the old line must be highlighted with a
        # non-zero width — not collapsed to an empty range.
        assert del_hl_spans, "tab+space region should be highlighted in deleted line"
        assert all(s < e for s, e in del_hl_spans), "highlight spans must have non-zero width"
        assert add_hl_spans, "space region should be highlighted in added line"
        assert all(s < e for s, e in add_hl_spans), "highlight spans must have non-zero width"

    def test_inline_diff_tab_to_spaces_precise(self) -> None:
        """Highlight spans must cover exactly the indentation region."""
        # "a\tb" with tab_size=4: rendered as "a   b" (tab expands to 3 spaces)
        # "a   b": literal 3 spaces
        # The only difference is the tab vs 3 spaces — both render as "a   b".
        # The highlight should cover the whitespace region (rendered[1:4]).
        old = "a\tb"
        new = "a   b"
        hunks = _build_diff_lines(old, new, 1, 1)
        hl = _make_highlighter("test.txt")
        _highlight_hunk(hl, hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].is_inline_paired
        assert adds[0].is_inline_paired
        from kimi_cli.utils.rich.diff_render import get_diff_colors

        colors = get_diff_colors()
        assert deletes[0].content is not None
        assert adds[0].content is not None
        del_hl_spans = [
            (s.start, s.end) for s in deletes[0].content.spans if s.style == colors.del_hl
        ]
        add_hl_spans = [(s.start, s.end) for s in adds[0].content.spans if s.style == colors.add_hl]
        del_plain = deletes[0].content.plain  # "a   b"
        add_plain = adds[0].content.plain  # "a   b"
        del_highlighted = "".join(del_plain[s:e] for s, e in del_hl_spans)
        add_highlighted = "".join(add_plain[s:e] for s, e in add_hl_spans)
        # The highlighted region must be exactly the whitespace, not spill into "a" or "b".
        assert "a" not in del_highlighted, f"'a' should not be highlighted: {del_hl_spans}"
        assert "b" not in del_highlighted, f"'b' should not be highlighted: {del_hl_spans}"
        assert "a" not in add_highlighted, f"'a' should not be highlighted: {add_hl_spans}"
        assert "b" not in add_highlighted, f"'b' should not be highlighted: {add_hl_spans}"
        assert del_hl_spans, "whitespace region should be highlighted in deleted line"
        assert add_hl_spans, "whitespace region should be highlighted in added line"

    def test_inline_diff_multiple_tabs_precise(self) -> None:
        """Changing only the first tab must not highlight the second tab."""
        # old: "a\t\ta" with tab_size=4 renders as "a       a"
        #       a=col0, tab1 expands to 3sp (cols 1-3), tab2 expands to 4sp (cols 4-7), a=col8
        # new: "a \ta" renders as "a   a"
        #       a=col0, space=col1, tab expands to 2sp (cols 2-3), a=col4
        # Only the first tab (old rendered[1:4]) should be highlighted,
        # NOT the second tab (old rendered[4:8]).
        old = "a\t\ta"
        new = "a \ta"
        hunks = _build_diff_lines(old, new, 1, 1)
        hl = _make_highlighter("test.txt")
        _highlight_hunk(hl, hunks[0])
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        assert deletes[0].is_inline_paired
        assert deletes[0].content is not None
        from kimi_cli.utils.rich.diff_render import get_diff_colors

        colors = get_diff_colors()
        del_hl_spans = [
            (s.start, s.end) for s in deletes[0].content.spans if s.style == colors.del_hl
        ]
        # The highlight in the old line must cover only the first tab's
        # rendered region [1:4], not spill into the second tab [4:8].
        assert del_hl_spans, "first tab region should be highlighted"
        for s, e in del_hl_spans:
            assert e <= 4, (
                f"highlight span ({s},{e}) extends into second tab region "
                f"(rendered[4:8]), should stop at 4"
            )

    def test_inline_diff_trailing_whitespace(self) -> None:
        """Trailing whitespace must be preserved and highlighted in diffs."""
        old = "hello   "
        new = "hello"
        hunks = _build_diff_lines(old, new, 1, 1)
        hl = _make_highlighter("test.txt")
        _highlight_hunk(hl, hunks[0])  # should not raise
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].is_inline_paired
        assert adds[0].is_inline_paired
        # Trailing spaces must be preserved in the rendered content,
        # not stripped away — they are a meaningful part of the diff.
        assert deletes[0].content is not None
        assert deletes[0].content.plain == "hello   "
        from kimi_cli.utils.rich.diff_render import get_diff_colors

        colors = get_diff_colors()
        del_hl_spans = [
            (s.start, s.end) for s in deletes[0].content.spans if s.style == colors.del_hl
        ]
        # The trailing spaces should be highlighted as the deleted region.
        del_highlighted = "".join(deletes[0].content.plain[s:e] for s, e in del_hl_spans)
        assert "   " in del_highlighted, (
            f"trailing spaces should be highlighted, got: {del_highlighted!r}"
        )


# ---------------------------------------------------------------------------
# collect_diff_hunks
# ---------------------------------------------------------------------------


class TestCollectDiffHunks:
    def test_counts_added_and_removed(self) -> None:
        hunks, added, removed = _collect("a\nb\nc", "a\nX\nc\nd")
        assert added == 2
        assert removed == 1

    def test_empty_blocks_return_empty(self) -> None:
        hunks, added, removed = collect_diff_hunks([])
        assert (hunks, added, removed) == ([], 0, 0)

    def test_identical_blocks_return_empty(self) -> None:
        hunks, added, removed = _collect("same", "same")
        assert (hunks, added, removed) == ([], 0, 0)

    def test_multiple_blocks(self) -> None:
        b1 = _make_block(old_text="a", new_text="b", old_start=1, new_start=1)
        b2 = _make_block(old_text="c", new_text="d", old_start=10, new_start=10)
        hunks, added, removed = collect_diff_hunks([b1, b2])
        assert len(hunks) == 2
        assert added > 0 and removed > 0


# ---------------------------------------------------------------------------
# _build_diff_header
# ---------------------------------------------------------------------------


class TestBuildDiffHeader:
    def test_added_and_removed(self) -> None:
        t = _build_diff_header("file.py", added=3, removed=2).plain
        assert "+3" in t and "-2" in t and "file.py" in t

    def test_only_added(self) -> None:
        t = _build_diff_header("file.py", added=5, removed=0).plain
        assert "+5" in t and "-" not in t

    def test_only_removed(self) -> None:
        t = _build_diff_header("file.py", added=0, removed=3).plain
        assert "-3" in t and "+" not in t

    def test_no_changes(self) -> None:
        assert _build_diff_header("file.py", 0, 0).plain == "file.py"

    def test_no_new_file_or_deleted_label(self) -> None:
        """Regression guard: pure add/remove should NOT show special labels."""
        assert "(new file)" not in _build_diff_header("f.py", 5, 0).plain
        assert "(deleted)" not in _build_diff_header("f.py", 0, 5).plain


# ---------------------------------------------------------------------------
# render_diff_panel
# ---------------------------------------------------------------------------


class TestRenderDiffPanel:
    def test_line_numbers_and_markers(self) -> None:
        hunks, added, removed = _collect("a\nb\nc", "a\nX\nc")
        text = _render_to_text(render_diff_panel("test.py", hunks, added, removed))
        assert "+" in text and "-" in text
        assert "1" in text and "2" in text

    def test_stats_in_title(self) -> None:
        hunks, added, removed = _collect("a\nb", "a\nc\nd")
        text = _render_to_text(render_diff_panel("test.py", hunks, added, removed))
        assert f"+{added}" in text and f"-{removed}" in text

    def test_hunk_separator(self) -> None:
        lines = [f"line {i}" for i in range(20)]
        old = "\n".join(lines)
        new_lines = lines.copy()
        new_lines[1] = "X"
        new_lines[18] = "X"
        hunks, a, r = _collect(old, "\n".join(new_lines))
        assert len(hunks) == 2
        assert "⋮" in _render_to_text(render_diff_panel("test.py", hunks, a, r))

    def test_empty_hunks_no_crash(self) -> None:
        text = _render_to_text(render_diff_panel("test.py", [], 0, 0))
        assert "test.py" in text

    def test_pure_add_no_special_label(self) -> None:
        hunks, a, r = _collect("", "line1\nline2")
        text = _render_to_text(render_diff_panel("test.py", hunks, a, r))
        assert "(new file)" not in text
        assert f"+{a}" in text

    def test_context_lines_rendered(self) -> None:
        """Context lines (unchanged) should appear in full panel."""
        hunks, a, r = _collect("ctx\nold\nctx2", "ctx\nnew\nctx2")
        text = _render_to_text(render_diff_panel("test.py", hunks, a, r))
        assert "ctx" in text and "ctx2" in text


# ---------------------------------------------------------------------------
# render_diff_preview
# ---------------------------------------------------------------------------


class TestRenderDiffPreview:
    def test_excludes_context_lines(self) -> None:
        hunks, a, r = _collect("ctx1\nold\nctx2", "ctx1\nnew\nctx2")
        renderables, _ = render_diff_preview("test.py", hunks, a, r)
        full = "\n".join(_render_to_text(x) for x in renderables)
        assert "ctx1" not in full and "ctx2" not in full

    def test_truncation_with_hint(self) -> None:
        old = "\n".join(f"line{i}" for i in range(20))
        new = "\n".join(f"LINE{i}" for i in range(20))
        hunks, a, r = _collect(old, new)
        renderables, remaining = render_diff_preview("test.py", hunks, a, r, max_lines=4)
        assert remaining > 0
        assert "more lines" in _render_to_text(renderables[-1])

    def test_no_truncation_within_limit(self) -> None:
        hunks, a, r = _collect("old", "new")
        _, remaining = render_diff_preview("test.py", hunks, a, r)
        assert remaining == 0

    def test_header_present(self) -> None:
        hunks, a, r = _collect("a", "b")
        renderables, _ = render_diff_preview("test.py", hunks, a, r)
        assert "test.py" in _render_to_text(renderables[0])

    def test_empty_hunks_header_only(self) -> None:
        renderables, remaining = render_diff_preview("test.py", [], 0, 0)
        assert len(renderables) == 1
        assert remaining == 0

    def test_inline_diff_in_preview(self) -> None:
        hunks, a, r = _collect("def hello(name):", "def hello(user_name):")
        renderables, _ = render_diff_preview("test.py", hunks, a, r)
        # header + 1 delete + 1 add
        assert len(renderables) == 3

    def test_multi_hunk_collects_changes_from_all_hunks(self) -> None:
        """Preview should gather changed lines from ALL hunks, not just the first."""
        lines = [f"line {i}" for i in range(20)]
        old = "\n".join(lines)
        new_lines = lines.copy()
        new_lines[1] = "CHANGED_NEAR_TOP"
        new_lines[18] = "CHANGED_NEAR_BOTTOM"
        hunks, a, r = _collect(old, "\n".join(new_lines))
        assert len(hunks) == 2  # two distant changes → two hunks
        renderables, remaining = render_diff_preview("test.py", hunks, a, r)
        full = "\n".join(_render_to_text(x) for x in renderables)
        assert "CHANGED_NEAR_TOP" in full
        assert "CHANGED_NEAR_BOTTOM" in full

    def test_truncation_midway_through_paired_block(self) -> None:
        """Truncation may split a paired delete/add block — should not crash."""
        old = "\n".join(f"old_{i}" for i in range(10))
        new = "\n".join(f"new_{i}" for i in range(10))
        hunks, a, r = _collect(old, new)
        # 20 changed lines (10 del + 10 add), limit to 5
        renderables, remaining = render_diff_preview("test.py", hunks, a, r, max_lines=5)
        assert remaining == 15
        # All shown lines should have content (no None assertion errors)
        for renderable in renderables[1:]:  # skip header
            text = _render_to_text(renderable)
            assert len(text.strip()) > 0


# ---------------------------------------------------------------------------
# Integration: line number offsets end-to-end
# ---------------------------------------------------------------------------


class TestLineNumberOffsets:
    def test_offset_propagated_to_diff_lines(self) -> None:
        hunks, _, _ = collect_diff_hunks(
            [_make_block(old_text="old", new_text="new", old_start=50, new_start=60)]
        )
        deletes = [dl for dl in hunks[0] if dl.kind == DiffLineKind.DELETE]
        adds = [dl for dl in hunks[0] if dl.kind == DiffLineKind.ADD]
        assert deletes[0].old_num == 50
        assert adds[0].new_num == 60

    def test_offset_visible_in_rendered_panel(self) -> None:
        hunks, a, r = collect_diff_hunks(
            [_make_block(old_text="old", new_text="new", old_start=100, new_start=200)]
        )
        text = _render_to_text(render_diff_panel("test.py", hunks, a, r))
        assert "100" in text and "200" in text

    def test_build_diff_blocks_sets_correct_offsets(self) -> None:
        """build_diff_blocks (diff.py) should set old_start/new_start for multi-hunk diffs."""
        lines = [f"line {i}" for i in range(20)]
        old_text = "\n".join(lines)
        new_lines = lines.copy()
        new_lines[1] = "CHANGED"
        new_lines[18] = "CHANGED"
        blocks = build_diff_blocks("test.py", old_text, "\n".join(new_lines))
        assert len(blocks) == 2
        b0 = blocks[0]
        b1 = blocks[1]
        assert isinstance(b0, DiffDisplayBlock)
        assert isinstance(b1, DiffDisplayBlock)
        # First block starts near the beginning
        assert b0.old_start == 1
        assert b0.new_start == 1
        # Second block starts later — NOT at 1
        assert b1.old_start > 1
        assert b1.new_start > 1


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_empty_line_diff(self) -> None:
        hunks, a, r = _collect("a\n\nb", "a\nb")
        _render_to_text(render_diff_panel("test.py", hunks, a, r))

    def test_unicode_content(self) -> None:
        hunks, a, r = _collect("你好世界", "こんにちは世界")
        text = _render_to_text(render_diff_panel("test.py", hunks, a, r))
        assert "你好" in text or "こんにちは" in text

    def test_very_long_line(self) -> None:
        long = "x" * 500
        hunks, a, r = _collect(long, long + "_mod")
        _render_to_text(render_diff_panel("test.py", hunks, a, r))

    @pytest.mark.parametrize("path", ["file.xyzunknown", "Makefile", "noext"])
    def test_fallback_highlighting(self, path: str) -> None:
        """Unknown/missing extension should not crash — falls back to plain text."""
        hunks, a, r = collect_diff_hunks([_make_block(path=path, old_text="a", new_text="b")])
        _render_to_text(render_diff_panel(path, hunks, a, r))
