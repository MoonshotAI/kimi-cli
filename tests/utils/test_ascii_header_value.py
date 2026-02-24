from __future__ import annotations

from kimi_cli.auth.oauth import _ascii_header_value


def test_strips_trailing_whitespace() -> None:
    """platform.version() on some Linux systems returns a trailing space."""
    value = "#100~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC Mon Jan 19 17:10:19 UTC "
    assert _ascii_header_value(value) == value.strip()


def test_strips_leading_whitespace() -> None:
    value = " some-value"
    assert _ascii_header_value(value) == "some-value"


def test_clean_ascii_value_unchanged() -> None:
    value = "KimiCLI/1.13.0"
    assert _ascii_header_value(value) == value


def test_non_ascii_stripped_and_trimmed() -> None:
    value = "héllo wörld "
    result = _ascii_header_value(value)
    assert result == "hllo wrld"


def test_empty_after_sanitize_returns_fallback() -> None:
    value = "日本語"
    assert _ascii_header_value(value) == "unknown"


def test_custom_fallback() -> None:
    value = "日本語"
    assert _ascii_header_value(value, fallback="n/a") == "n/a"


def test_whitespace_only_returns_fallback() -> None:
    value = "   "
    assert _ascii_header_value(value) == "unknown"
