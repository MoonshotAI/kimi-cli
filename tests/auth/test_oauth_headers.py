"""Tests for HTTP header value sanitization.

Covers three layers:
1. Unit tests — verify _ascii_header_value() behavior
2. h11 integration — sanitized values pass h11 validation
3. aiohttp integration — sanitized values pass aiohttp validation
"""

import pytest

from kimi_cli.auth.oauth import _ascii_header_value

# ---------------------------------------------------------------------------
# Layer 1: Unit tests
# ---------------------------------------------------------------------------


class TestAsciiHeaderValue:
    """Unit tests for _ascii_header_value()."""

    def test_normal_ascii_passthrough(self):
        assert _ascii_header_value("Darwin 24.5.0") == "Darwin 24.5.0"

    def test_newline_removed(self):
        val = "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC\n"
        result = _ascii_header_value(val)
        assert "\n" not in result
        assert result == "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC"

    def test_carriage_return_removed(self):
        assert _ascii_header_value("value\r") == "value"

    def test_crlf_removed(self):
        assert _ascii_header_value("value\r\n") == "value"

    def test_null_byte_removed(self):
        assert _ascii_header_value("val\x00ue") == "value"

    def test_control_characters_removed(self):
        # \x01-\x08, \x0e-\x1f, \x7f are control characters
        assert _ascii_header_value("a\x01b\x08c\x0ed\x1fe\x7f") == "abcde"

    def test_non_ascii_removed(self):
        assert _ascii_header_value("value日本語end") == "valueend"

    def test_empty_string_returns_fallback(self):
        assert _ascii_header_value("") == "unknown"

    def test_only_control_chars_returns_fallback(self):
        assert _ascii_header_value("\n\r\x00") == "unknown"

    def test_only_non_ascii_returns_fallback(self):
        assert _ascii_header_value("日本語") == "unknown"

    def test_custom_fallback(self):
        assert _ascii_header_value("", fallback="n/a") == "n/a"

    def test_internal_spaces_preserved(self):
        assert _ascii_header_value("a b c") == "a b c"

    def test_internal_tab_preserved(self):
        assert _ascii_header_value("a\tb") == "a\tb"

    def test_leading_trailing_whitespace_stripped(self):
        assert _ascii_header_value("  hello  ") == "hello"

    def test_hash_preserved(self):
        """# is VCHAR (0x23), perfectly valid in HTTP header values."""
        val = "#101~22.04.1-Ubuntu"
        assert _ascii_header_value(val) == val

    def test_special_chars_preserved(self):
        """Parentheses, braces, @, etc. are all valid VCHAR."""
        val = "Linux (x86_64) {test} @host"
        assert _ascii_header_value(val) == val

    def test_realistic_ubuntu_kernel_version(self):
        """The exact scenario from issue #1368."""
        val = "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC Mon Jan 13 17:42:59 UTC 2\n"
        result = _ascii_header_value(val)
        assert "\n" not in result
        assert result.startswith("#101")
        assert result.endswith("UTC 2")


# ---------------------------------------------------------------------------
# Layer 2: h11 integration tests
# ---------------------------------------------------------------------------


class TestH11Integration:
    """Verify sanitized values pass h11's header validation."""

    @pytest.fixture()
    def h11_validate(self):
        from h11._headers import normalize_and_validate

        def _validate(value: str):
            headers = [(b"X-Test-Header", value.encode("ascii"))]
            normalize_and_validate(headers, _parsed=False)

        return _validate

    @pytest.mark.parametrize(
        "raw",
        [
            "Darwin 24.5.0",
            "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC\n",
            "value\r\ninjection",
            "val\x00ue",
            "a\x01b\x08c",
            "日本語mixed",
            "",
            "\n\r\x00",
            "  spaces  ",
            "a\tb",
        ],
        ids=[
            "normal_ascii",
            "trailing_newline",
            "crlf_injection",
            "null_byte",
            "control_chars",
            "non_ascii_mixed",
            "empty",
            "only_control",
            "leading_trailing_spaces",
            "internal_tab",
        ],
    )
    def test_sanitized_value_accepted_by_h11(self, h11_validate, raw):
        sanitized = _ascii_header_value(raw)
        # Should not raise
        h11_validate(sanitized)


# ---------------------------------------------------------------------------
# Layer 3: aiohttp integration tests
# ---------------------------------------------------------------------------


class TestAiohttpIntegration:
    """Verify sanitized values pass aiohttp's header validation."""

    @pytest.fixture()
    def aiohttp_validate(self):
        try:
            from aiohttp.http_writer import _safe_header  # type: ignore[attr-defined]
        except ImportError:
            pytest.skip("aiohttp _safe_header not available")

        def _validate(value: str):
            # _safe_header validates the full "Name: value" string
            _safe_header(f"X-Test-Header: {value}")

        return _validate

    @pytest.mark.parametrize(
        "raw",
        [
            "Darwin 24.5.0",
            "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC\n",
            "value\r\ninjection",
            "val\x00ue",
            "a\x01b\x08c",
            "日本語mixed",
            "",
            "\n\r\x00",
            "  spaces  ",
            "a\tb",
        ],
        ids=[
            "normal_ascii",
            "trailing_newline",
            "crlf_injection",
            "null_byte",
            "control_chars",
            "non_ascii_mixed",
            "empty",
            "only_control",
            "leading_trailing_spaces",
            "internal_tab",
        ],
    )
    def test_sanitized_value_accepted_by_aiohttp(self, aiohttp_validate, raw):
        sanitized = _ascii_header_value(raw)
        # Should not raise
        aiohttp_validate(sanitized)
