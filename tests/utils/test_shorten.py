"""Unit tests for the custom shorten() function in kimi_cli.utils.string."""

from __future__ import annotations


def test_short_text_returned_unchanged():
    from kimi_cli.utils.string import shorten

    assert shorten("hello", width=10) == "hello"


def test_exact_width_returned_unchanged():
    from kimi_cli.utils.string import shorten

    assert shorten("hello", width=5) == "hello"


def test_truncates_at_word_boundary():
    from kimi_cli.utils.string import shorten

    result = shorten("hello world foo bar", width=12)
    assert result == "hello world…"


def test_cjk_text_hard_cut_no_collapse():
    """CJK text without spaces must NOT collapse to just the placeholder."""
    from kimi_cli.utils.string import shorten

    text = "这是一段很长的中文文本用于测试截断功能"
    result = shorten(text, width=10)
    assert len(result) <= 10
    assert result == "这是一段很长的中文文本"[:9] + "…"
    # Key assertion: result is NOT just the placeholder
    assert result != "…"


def test_whitespace_normalised():
    from kimi_cli.utils.string import shorten

    result = shorten("hello   world\nfoo", width=20)
    assert result == "hello world foo"


def test_empty_string():
    from kimi_cli.utils.string import shorten

    assert shorten("", width=10) == ""


def test_width_equals_one_with_long_text():
    """Edge case: width=1 with text longer than 1 char."""
    from kimi_cli.utils.string import shorten

    result = shorten("hello", width=1)
    assert len(result) <= 1


def test_custom_placeholder():
    from kimi_cli.utils.string import shorten

    result = shorten("hello world foo bar", width=12, placeholder="...")
    assert result.endswith("...")
    assert len(result) <= 12


def test_placeholder_longer_than_cut():
    """When cut <= 0, fall back to hard cut without placeholder."""
    from kimi_cli.utils.string import shorten

    result = shorten("hello", width=1, placeholder="...")
    assert len(result) <= 1
    assert result == "h"
