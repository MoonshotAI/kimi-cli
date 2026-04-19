"""Tests for streaming content block: incremental markdown commitment,
token estimation, and related utilities."""

from __future__ import annotations

import pytest

from kimi_cli.ui.shell.visualize import (
    _ContentBlock,
    _estimate_tokens,
    _find_committed_boundary,
    _tail_lines,
    _truncate_to_display_width,
)

# ---------------------------------------------------------------------------
# _estimate_tokens
# ---------------------------------------------------------------------------


class TestEstimateTokens:
    def test_english_text(self):
        # ~1 token per 4 chars
        assert _estimate_tokens("Hello world!") == pytest.approx(3.0)

    def test_chinese_text(self):
        # ~1.5 tokens per CJK char
        assert _estimate_tokens("你好世界") == pytest.approx(6.0)

    def test_mixed_text(self):
        result = _estimate_tokens("Hello 你好")
        # "Hello " = 6 other chars -> 1.5; "你好" = 2 CJK -> 3.0; total = 4.5
        assert result == pytest.approx(4.5)

    def test_empty_string(self):
        assert _estimate_tokens("") == 0.0

    def test_returns_float(self):
        """Ensure float is returned so callers can accumulate without truncation."""
        result = _estimate_tokens("abc")
        assert isinstance(result, float)
        assert result == pytest.approx(0.75)

    def test_small_chunk_accumulation(self):
        """100 x 3-char chunks should accumulate to ~75 tokens, not 0."""
        total = sum(_estimate_tokens("abc") for _ in range(100))
        assert int(total) == 75

    def test_single_char_accumulation(self):
        total = sum(_estimate_tokens("a") for _ in range(100))
        assert int(total) == 25

    def test_cjk_punctuation(self):
        # CJK symbols range U+3000-U+303F — e.g. 、。
        result = _estimate_tokens("、。")
        assert result == pytest.approx(3.0)

    def test_fullwidth_characters(self):
        # Fullwidth range U+FF00-U+FFEF — e.g. Ａ
        result = _estimate_tokens("\uff21")  # Ａ
        assert result == pytest.approx(1.5)


# ---------------------------------------------------------------------------
# _find_committed_boundary
# ---------------------------------------------------------------------------


class TestFindCommittedBoundary:
    def test_two_paragraphs(self):
        text = "First paragraph.\n\nSecond paragraph."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        assert text[:boundary].strip() == "First paragraph."

    def test_single_block_returns_none(self):
        assert _find_committed_boundary("Just one paragraph.") is None

    def test_empty_string(self):
        assert _find_committed_boundary("") is None

    def test_list_as_single_block(self):
        """An entire list must be treated as one block, not split per item."""
        text = "Intro.\n\n- item 1\n- item 2\n- item 3\n\nAfter."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        confirmed = text[:boundary]
        # Both intro and entire list should be confirmed.
        assert "Intro." in confirmed
        assert "item 1" in confirmed
        assert "item 3" in confirmed
        # "After." should remain as pending.
        assert "After." in text[boundary:]

    def test_incomplete_fence(self):
        """An unclosed code fence should not be committed."""
        text = "Before.\n\n```python\ndef foo():"
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        confirmed = text[:boundary]
        assert "Before." in confirmed
        # The unclosed fence stays as pending.
        assert "```python" in text[boundary:]

    def test_complete_fence(self):
        text = "Before.\n\n```python\nprint(1)\n```\n\nAfter."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        confirmed = text[:boundary]
        assert "print(1)" in confirmed
        assert "After." in text[boundary:]

    def test_blockquote_as_single_block(self):
        text = "Intro.\n\n> line 1\n> line 2\n\nAfter."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        confirmed = text[:boundary]
        assert "line 1" in confirmed
        assert "line 2" in confirmed
        assert "After." in text[boundary:]

    def test_table_as_single_block(self):
        text = "Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        confirmed = text[:boundary]
        assert "| a | b |" in confirmed
        assert "After." in text[boundary:]

    def test_heading_then_paragraph(self):
        text = "# Title\n\nParagraph."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        assert "# Title" in text[:boundary]

    def test_hr(self):
        text = "Before.\n\n---\n\nAfter."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        assert "Before." in text[:boundary]

    def test_only_newlines(self):
        assert _find_committed_boundary("\n\n\n") is None

    def test_boundary_is_exact_char_offset(self):
        """Returned offset must allow text[:offset] + text[offset:] == text."""
        text = "AAA.\n\nBBB.\n\nCCC."
        boundary = _find_committed_boundary(text)
        assert boundary is not None
        assert text[:boundary] + text[boundary:] == text


# ---------------------------------------------------------------------------
# _tail_lines
# ---------------------------------------------------------------------------
# _truncate_to_display_width
# ---------------------------------------------------------------------------


class TestTruncateToDisplayWidth:
    def test_short_ascii_unchanged(self):
        assert _truncate_to_display_width("Hello", 30) == "Hello"

    def test_long_ascii_truncated(self):
        result = _truncate_to_display_width("A" * 50, 20)
        from rich.cells import cell_len

        assert cell_len(result) <= 20
        assert result.endswith("...")

    def test_cjk_truncated_by_display_width(self):
        """50 CJK chars = 100 columns; should be truncated at max_width=30."""
        line = "你" * 50
        result = _truncate_to_display_width(line, 30)
        from rich.cells import cell_len

        assert cell_len(result) <= 30
        assert result.endswith("...")

    def test_cjk_short_unchanged(self):
        assert _truncate_to_display_width("你好", 10) == "你好"

    def test_mixed_cjk_ascii(self):
        result = _truncate_to_display_width("Hello你好World世界TestTest", 20)
        from rich.cells import cell_len

        assert cell_len(result) <= 20
        assert result.endswith("...")

    def test_empty_string(self):
        assert _truncate_to_display_width("", 10) == ""

    def test_exact_fit(self):
        """Line that exactly fills max_width should not be truncated."""
        assert _truncate_to_display_width("abcde", 5) == "abcde"


# ---------------------------------------------------------------------------
# _tail_lines
# ---------------------------------------------------------------------------


class TestTailLines:
    def test_basic(self):
        text = "a\nb\nc\nd\ne"
        assert _tail_lines(text, 2) == "d\ne"

    def test_fewer_lines_than_requested(self):
        assert _tail_lines("a\nb", 10) == "a\nb"

    def test_no_newlines(self):
        assert _tail_lines("hello", 5) == "hello"

    def test_exact_count(self):
        text = "1\n2\n3"
        assert _tail_lines(text, 3) == "1\n2\n3"

    def test_empty_string(self):
        assert _tail_lines("", 3) == ""

    def test_large_text(self):
        text = "\n".join(f"line {i}" for i in range(1000))
        tail = _tail_lines(text, 3)
        assert tail == "line 997\nline 998\nline 999"


# ---------------------------------------------------------------------------
# _ContentBlock integration
# ---------------------------------------------------------------------------


class TestContentBlockTokenCount:
    """Verify token accumulation works correctly with small chunks."""

    def test_small_english_chunks(self):
        block = _ContentBlock(is_think=True)
        for _ in range(100):
            block.append("abc")
        # 300 chars / 4 = 75 tokens
        assert int(block._token_count) == 75

    def test_small_chinese_chunks(self):
        block = _ContentBlock(is_think=True)
        for _ in range(100):
            block.append("你")
        # 100 CJK * 1.5 = 150 tokens
        assert int(block._token_count) == 150

    def test_mixed_accumulation(self):
        block = _ContentBlock(is_think=True)
        block.append("Hi")  # 0.5
        block.append("你好")  # 3.0
        block.append("world")  # 1.25
        assert block._token_count == pytest.approx(4.75)


class TestContentBlockCommitment:
    """Verify incremental commitment for composing blocks."""

    def test_thinking_never_commits(self):
        block = _ContentBlock(is_think=True)
        block.append("First.\n\nSecond.\n\nThird.")
        assert block._committed_len == 0

    def test_composing_commits_on_newline(self):
        block = _ContentBlock(is_think=False)
        block.append("First paragraph.\n\nSecond paragraph.\n\nThird.")
        assert block._committed_len > 0
        pending = block.raw_text[block._committed_len :]
        assert "Third." in pending

    def test_composing_no_commit_without_newline(self):
        block = _ContentBlock(is_think=False)
        block.append("just some text without newlines")
        assert block._committed_len == 0

    def test_newline_split_across_chunks(self):
        """Block boundary \\n\\n split across two chunks should still commit."""
        block = _ContentBlock(is_think=False)
        block.append("First paragraph.\n")
        assert block._committed_len == 0  # Only one \n so far, can't form boundary
        block.append("\nSecond paragraph.\n")
        # Now pending has "First paragraph.\n\nSecond paragraph.\n"
        # But _flush_committed needs 2 blocks — "First paragraph.\n\n" + "Second paragraph.\n"
        # The second \n chunk triggers the check.
        block.append("\nThird.")
        # Now should have committed first two paragraphs
        assert block._committed_len > 0

    def test_has_pending(self):
        block = _ContentBlock(is_think=False)
        block.append("Para 1.\n\nPara 2.\n\nPara 3.")
        assert block.has_pending()

    def test_bullet_printed_once(self):
        block = _ContentBlock(is_think=False)
        assert not block._has_printed_bullet
        block.append("First.\n\nSecond.\n\nThird.")
        # After first commit, bullet should be marked as printed
        if block._committed_len > 0:
            assert block._has_printed_bullet


# ---------------------------------------------------------------------------
# show_thinking_stream toggle (legacy streaming reasoning preview)
# ---------------------------------------------------------------------------


class TestShowThinkingStream:
    """The ``show_thinking_stream`` flag opts back into the pre-1.32 behavior
    where thinking content is rendered as a 6-line scrolling preview during
    streaming and committed to history as full markdown when the block ends.
    The default (``False``) keeps the compact 'Thinking ...' indicator and
    one-line ``Thought for ...`` trace introduced in 1.32.
    """

    def test_compact_mode_compose_returns_compact_text(self):
        from rich.text import Text

        block = _ContentBlock(is_think=True)
        block.append("Some reasoning content")
        result = block.compose()
        assert isinstance(result, Text)
        assert "Thinking" in result.plain
        # Compact mode never renders the raw reasoning text
        assert "reasoning content" not in result.plain

    def test_stream_mode_compose_returns_group_with_preview(self):
        from rich.console import Group

        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        block.append("line 1\nline 2\nline 3")
        result = block.compose()
        assert isinstance(result, Group)

    def test_stream_mode_compose_no_pending_returns_spinner_only(self):
        from rich.spinner import Spinner

        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        # No content appended yet — should fall back to the bare spinner.
        result = block.compose()
        assert isinstance(result, Spinner)

    def test_stream_mode_spinner_uses_thinking_label(self):
        """Stream mode must restore the legacy 'Thinking...' spinner label."""
        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        result = block.compose()
        # Spinner.text is a Text — extract its plain string for assertion
        text = result.text  # type: ignore[reportAttributeAccessIssue]
        plain = text.plain if hasattr(text, "plain") else str(text)
        assert "Thinking" in plain

    def test_compact_mode_compose_final_returns_trace_line(self):
        from rich.text import Text

        block = _ContentBlock(is_think=True)
        block.append("Some thought content")
        result = block.compose_final()
        assert isinstance(result, Text)
        assert "Thought for" in result.plain
        assert "tokens" in result.plain
        # Compact trace must not contain the raw reasoning content
        assert "thought content" not in result.plain

    def test_stream_mode_compose_final_returns_markdown_bullet(self):
        """Stream mode commits the full reasoning to history (legacy behavior)."""
        from kimi_cli.utils.rich.columns import BulletColumns

        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        block.append("Some thought content")
        result = block.compose_final()
        assert isinstance(result, BulletColumns)

    def test_stream_mode_compose_final_empty_returns_empty_text(self):
        from rich.text import Text

        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        result = block.compose_final()
        assert isinstance(result, Text)
        assert result.plain == ""

    def test_compact_mode_has_pending_with_content(self):
        block = _ContentBlock(is_think=True)
        block.append("anything")
        assert block.has_pending()

    def test_compact_mode_has_pending_without_content(self):
        block = _ContentBlock(is_think=True)
        assert not block.has_pending()

    def test_stream_mode_has_pending_with_content(self):
        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        block.append("anything")
        assert block.has_pending()

    def test_stream_mode_has_pending_without_content(self):
        block = _ContentBlock(is_think=True, show_thinking_stream=True)
        assert not block.has_pending()

    def test_thinking_never_commits_in_either_mode(self):
        """Thinking blocks must never commit incrementally regardless of mode."""
        for stream in (False, True):
            block = _ContentBlock(is_think=True, show_thinking_stream=stream)
            block.append("First.\n\nSecond.\n\nThird.")
            assert block._committed_len == 0

    def test_preview_constant_is_six_lines(self):
        """Stream preview window matches the historical 6-line tail."""
        from kimi_cli.ui.shell.visualize._blocks import _THINKING_PREVIEW_LINES

        assert _THINKING_PREVIEW_LINES == 6

    def test_show_thinking_stream_ignored_for_composing_blocks(self):
        """The flag only affects thinking blocks — composing path is unchanged."""
        block_off = _ContentBlock(is_think=False, show_thinking_stream=False)
        block_on = _ContentBlock(is_think=False, show_thinking_stream=True)
        for block in (block_off, block_on):
            block.append("hello\n\nworld")
        # Both should commit identically
        assert block_off._committed_len == block_on._committed_len
