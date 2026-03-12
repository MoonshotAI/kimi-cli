"""Tests for _ascii_header_value and _common_headers in oauth module.

Regression tests for the issue where Linux kernel version strings containing
'#' characters and trailing whitespace (e.g. platform.version() returning
"#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC ...") would produce invalid HTTP
header values, causing connection errors.

See: https://github.com/MoonshotAI/kimi-cli/issues/1389
"""

from unittest.mock import patch

from kimi_cli.auth.oauth import _ascii_header_value, _common_headers


class TestAsciiHeaderValue:
    """Test cases for _ascii_header_value."""

    def test_plain_ascii(self) -> None:
        assert _ascii_header_value("hello") == "hello"

    def test_strips_trailing_newline(self) -> None:
        """Regression: Linux platform.version() may contain trailing newline."""
        assert _ascii_header_value("6.8.0-101\n") == "6.8.0-101"

    def test_strips_hash_character(self) -> None:
        """Regression (#1389): '#' in kernel version causes connection errors."""
        result = _ascii_header_value(
            "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC Wed Feb 11 13:19:54 UTC 2025"
        )
        assert "#" not in result
        assert "101~22.04.1-Ubuntu" in result

    def test_strips_control_characters(self) -> None:
        assert _ascii_header_value("hello\x00world") == "helloworld"

    def test_non_ascii_sanitized(self) -> None:
        assert _ascii_header_value("héllo") == "hllo"

    def test_all_non_ascii_returns_fallback(self) -> None:
        assert _ascii_header_value("你好") == "unknown"

    def test_empty_string_returns_fallback(self) -> None:
        assert _ascii_header_value("") == "unknown"

    def test_custom_fallback(self) -> None:
        assert _ascii_header_value("你好", fallback="n/a") == "n/a"


class TestCommonHeaders:
    """Test that _common_headers returns clean header values."""

    @patch("kimi_cli.auth.oauth.platform")
    @patch("kimi_cli.auth.oauth.get_device_id", return_value="abc123")
    def test_no_unsafe_chars_in_header_values(self, _mock_device_id, mock_platform) -> None:
        """All header values must be free of '#', control chars, and whitespace padding."""
        mock_platform.node.return_value = "myhost"
        mock_platform.version.return_value = (
            "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC Wed Feb 11 13:19:54 UTC 2025\n"
        )
        headers = _common_headers()
        for key, value in headers.items():
            assert value == value.strip(), f"Header {key!r} has untrimmed whitespace: {value!r}"
            assert "#" not in value, f"Header {key!r} contains '#': {value!r}"
