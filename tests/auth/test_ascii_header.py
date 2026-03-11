"""Tests for _ascii_header_value and _common_headers in oauth module.

Regression tests for the issue where Linux kernel version strings containing
trailing whitespace/newlines (e.g. platform.version() returning
"#101-Ubuntu SMP ...\n") would be included in HTTP headers, causing
connection errors.
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

    def test_non_ascii_sanitized(self) -> None:
        assert _ascii_header_value("héllo") == "hllo"

    def test_all_non_ascii_returns_fallback(self) -> None:
        assert _ascii_header_value("你好") == "unknown"


class TestCommonHeaders:
    """Test that _common_headers returns clean header values."""

    @patch("kimi_cli.auth.oauth.platform")
    @patch("kimi_cli.auth.oauth.get_device_id", return_value="abc123")
    def test_no_whitespace_in_header_values(self, _mock_device_id, mock_platform) -> None:
        """All header values must be free of leading/trailing whitespace."""
        mock_platform.node.return_value = "myhost"
        mock_platform.version.return_value = "#101-Ubuntu SMP\n"
        headers = _common_headers()
        for key, value in headers.items():
            assert value == value.strip(), f"Header {key!r} has untrimmed whitespace: {value!r}"
