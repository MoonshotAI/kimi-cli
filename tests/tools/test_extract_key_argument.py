"""Tests for extract_key_argument and related utilities."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from kimi_cli.tools import _get_key_argument_width, extract_key_argument


class TestGetKeyArgumentWidth:
    """Tests for _get_key_argument_width function."""

    def test_returns_min_width_on_narrow_terminal(self):
        with patch("shutil.get_terminal_size") as mock:
            mock.return_value.columns = 40
            # 40 - 20 (overhead) = 20, but min is 50
            assert _get_key_argument_width() == 50

    def test_returns_calculated_width_on_normal_terminal(self):
        with patch("shutil.get_terminal_size") as mock:
            mock.return_value.columns = 100
            # 100 - 20 (overhead) = 80
            assert _get_key_argument_width() == 80

    def test_returns_max_width_on_wide_terminal(self):
        with patch("shutil.get_terminal_size") as mock:
            mock.return_value.columns = 200
            # 200 - 20 = 180, but max is 120
            assert _get_key_argument_width() == 120

    def test_returns_min_width_on_error(self):
        with patch("shutil.get_terminal_size", side_effect=OSError):
            assert _get_key_argument_width() == 50


class TestExtractKeyArgument:
    """Tests for extract_key_argument function."""

    def test_shell_command_extraction(self):
        args = json.dumps({"command": "echo hello"})
        result = extract_key_argument(args, "Shell")
        assert result == "echo hello"

    def test_shell_command_with_explicit_width(self):
        long_cmd = "echo " + "x" * 100
        args = json.dumps({"command": long_cmd})
        result = extract_key_argument(args, "Shell", width=30)
        assert result is not None
        # shorten_middle uses width//2 from each side + "...", so actual length is width//2*2+3
        assert len(result) <= 30 + 3
        assert "..." in result

    def test_shell_command_truncation_with_terminal_width(self):
        long_cmd = "cd /very/long/path/to/some/directory && make build test"
        args = json.dumps({"command": long_cmd})

        with patch("shutil.get_terminal_size") as mock:
            mock.return_value.columns = 120
            result = extract_key_argument(args, "Shell")
            # 120 - 20 = 100, command is 55 chars, should not truncate
            assert result == long_cmd

        # Use a longer command to ensure truncation
        very_long_cmd = "cd /very/long/path/to/some/directory && " + "x" * 50
        args = json.dumps({"command": very_long_cmd})
        with patch("shutil.get_terminal_size") as mock:
            mock.return_value.columns = 60
            result = extract_key_argument(args, "Shell")
            # 60 - 20 = 40 < 50 (min), so width=50
            assert result is not None
            assert "..." in result
            # Result should be around 50 chars (width//2 * 2 + 3)
            assert len(result) <= 53

    def test_read_file_path_extraction(self):
        args = json.dumps({"path": "src/main.py"})
        result = extract_key_argument(args, "ReadFile")
        assert result == "src/main.py"

    def test_grep_pattern_extraction(self):
        args = json.dumps({"pattern": "TODO"})
        result = extract_key_argument(args, "Grep")
        assert result == "TODO"

    def test_invalid_json_returns_none(self):
        result = extract_key_argument("not valid json", "Shell")
        assert result is None

    def test_missing_key_returns_none(self):
        args = json.dumps({"other_key": "value"})
        result = extract_key_argument(args, "Shell")
        assert result is None

    def test_empty_args_returns_none(self):
        result = extract_key_argument("{}", "Shell")
        assert result is None

    @pytest.mark.parametrize(
        "tool_name,args,expected_key",
        [
            ("Task", {"description": "Do something"}, "Do something"),
            ("CreateSubagent", {"name": "worker"}, "worker"),
            ("Think", {"thought": "I need to..."}, "I need to..."),
            ("Glob", {"pattern": "**/*.py"}, "**/*.py"),
            ("WriteFile", {"path": "output.txt", "content": "..."}, "output.txt"),
            ("StrReplaceFile", {"path": "file.py", "old": "a", "new": "b"}, "file.py"),
            ("SearchWeb", {"query": "python docs"}, "python docs"),
            ("FetchURL", {"url": "https://example.com"}, "https://example.com"),
        ],
    )
    def test_various_tools_extraction(self, tool_name: str, args: dict, expected_key: str):
        result = extract_key_argument(json.dumps(args), tool_name)
        assert result == expected_key
