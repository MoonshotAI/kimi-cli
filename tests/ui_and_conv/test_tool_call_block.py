from __future__ import annotations

import pytest

from kimi_cli.ui.shell.visualize import _ToolCallBlock


class TestExtractFullUrl:
    """Tests for _ToolCallBlock._extract_full_url static method."""

    def test_fetchurl_normal_url(self):
        url = _ToolCallBlock._extract_full_url(
            '{"url": "https://example.com/very/long/path"}', "FetchURL"
        )
        assert url == "https://example.com/very/long/path"

    def test_fetchurl_short_url(self):
        url = _ToolCallBlock._extract_full_url('{"url": "https://x.co"}', "FetchURL")
        assert url == "https://x.co"

    def test_non_fetchurl_tool(self):
        url = _ToolCallBlock._extract_full_url('{"url": "https://example.com"}', "ReadFile")
        assert url is None

    def test_arguments_none(self):
        url = _ToolCallBlock._extract_full_url(None, "FetchURL")
        assert url is None

    def test_invalid_json(self):
        url = _ToolCallBlock._extract_full_url("not json", "FetchURL")
        assert url is None

    def test_missing_url_field(self):
        url = _ToolCallBlock._extract_full_url('{"query": "hello"}', "FetchURL")
        assert url is None

    def test_empty_string(self):
        url = _ToolCallBlock._extract_full_url("", "FetchURL")
        assert url is None
