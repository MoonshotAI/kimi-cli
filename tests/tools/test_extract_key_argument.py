from __future__ import annotations

import pytest

from kimi_cli.tools import extract_key_argument


class TestExtractKeyArgument:
    """Tests for extract_key_argument with string inputs."""

    def test_fetchurl(self):
        result = extract_key_argument('{"url": "https://example.com/a/b/c"}', "FetchURL")
        assert result is not None
        assert "example.com" in result

    def test_shell(self):
        result = extract_key_argument('{"command": "ls -la"}', "Shell")
        assert result == "ls -la"

    def test_readfile(self):
        result = extract_key_argument('{"path": "foo/bar.py"}', "ReadFile")
        assert result is not None
        assert "foo/bar.py" in result

    def test_grep(self):
        result = extract_key_argument('{"pattern": "hello"}', "Grep")
        assert result == "hello"

    def test_invalid_json(self):
        result = extract_key_argument("invalid", "Shell")
        assert result is None

    def test_empty_json_object(self):
        result = extract_key_argument("{}", "Shell")
        assert result is None

    def test_sendmail_returns_none(self):
        result = extract_key_argument('{"to": "x"}', "SendDMail")
        assert result is None

    def test_long_content_truncated(self):
        long_url = "https://example.com/" + "a" * 200
        result = extract_key_argument(f'{{"url": "{long_url}"}}', "FetchURL")
        assert result is not None
        # shorten_middle(text, width=50) -> text[:25] + "..." + text[-25:]  => length 53
        assert len(result) <= 53

    def test_unknown_tool_returns_raw_content(self):
        result = extract_key_argument('{"a": 1}', "UnknownTool")
        assert result is not None
        assert result == '{"a": 1}'
