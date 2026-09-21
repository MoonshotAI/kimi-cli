"""Tests for shell_quoting defensive rewrites."""

from __future__ import annotations

import pytest

from kimi_cli.utils.shell_quoting import rewrite_windows_null_redirect


@pytest.mark.parametrize(
    "before, after",
    [
        # Bare redirects
        ("ls >nul", "ls >/dev/null"),
        ("ls > NUL", "ls > /dev/null"),
        # Numbered fd
        ("ls 2>nul", "ls 2>/dev/null"),
        # Combined fd
        ("ls &>nul", "ls &>/dev/null"),
        # Append
        ("ls >>nul", "ls >>/dev/null"),
        # Mixed case
        ("ls >Nul", "ls >/dev/null"),
        ("ls >NUL", "ls >/dev/null"),
        # Followed by pipe / shell operator
        ("ls 2>nul | grep foo", "ls 2>/dev/null | grep foo"),
        ("ls 2>nul; echo done", "ls 2>/dev/null; echo done"),
        ("ls 2>nul && echo ok", "ls 2>/dev/null && echo ok"),
        ("ls 2>nul) ", "ls 2>/dev/null) "),
        # Whitespace around the redirect
        ("ls 2>  nul", "ls 2>  /dev/null"),
        # End of string (no trailing whitespace)
        ("ls >nul", "ls >/dev/null"),
        # Multiple occurrences in one command
        ("foo >nul; bar 2>nul", "foo >/dev/null; bar 2>/dev/null"),
    ],
)
def test_rewrites_nul_redirect_on_windows(before: str, after: str):
    assert rewrite_windows_null_redirect(before, on_windows=True) == after


@pytest.mark.parametrize(
    "command",
    [
        # Should NOT be rewritten — these don't end the `nul` token
        "ls >null",
        "ls >nullable",
        "ls >nul.txt",
        "cat nul.txt",
        "echo nul",  # not a redirect
        "echo 'nul'",
        "ls > nul_file",
        # Word boundary: `nul` followed by alphanumeric
        "ls >nulX",
    ],
)
def test_does_not_rewrite_non_redirect_nul(command: str):
    assert rewrite_windows_null_redirect(command, on_windows=True) == command


def test_quoted_nul_with_closing_quote_not_rewritten():
    # The lookahead requires `\s|$|[|&;)\n]` after `nul`. A `"` immediately
    # after fails the lookahead, so quoted forms like `">nul"` slip through
    # unmolested. This is a happy accident — a more aggressive lookahead
    # would over-rewrite real string literals.
    assert rewrite_windows_null_redirect('echo ">nul"', on_windows=True) == 'echo ">nul"'


def test_empty_command_passthrough():
    assert rewrite_windows_null_redirect("", on_windows=True) == ""


def test_command_without_redirect_unchanged():
    cmd = "git status && git diff"
    assert rewrite_windows_null_redirect(cmd, on_windows=True) == cmd


@pytest.mark.parametrize(
    "command",
    [
        # On non-Windows, `>nul` is a legitimate redirect to a file named `nul`
        # and must NOT be rewritten — doing so would silently swallow output
        # the user intended to capture.
        "ls >nul",
        "ls 2>nul",
        "ls &>nul",
        "ls >>nul",
        "foo >nul; bar 2>nul",
    ],
)
def test_no_rewrite_on_non_windows(command: str):
    assert rewrite_windows_null_redirect(command, on_windows=False) == command
