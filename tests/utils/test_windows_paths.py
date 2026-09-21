"""Tests for posix_path_to_windows."""

from __future__ import annotations

import pytest

from kimi_cli.utils.windows_paths import posix_path_to_windows


@pytest.mark.parametrize(
    "posix, windows",
    [
        # MSYS/git-bash drive
        ("/c/Users/foo", r"C:\Users\foo"),
        ("/d/Projects/kimi", r"D:\Projects\kimi"),
        # Drive letter case is normalized to upper
        ("/C/Users/foo", r"C:\Users\foo"),
        # Drive root
        ("/c/", "C:\\"),
        ("/c", "C:\\"),
        # Cygwin drive
        ("/cygdrive/c/Users/foo", r"C:\Users\foo"),
        ("/cygdrive/d/Projects", r"D:\Projects"),
        # UNC
        ("//server/share", r"\\server\share"),
        ("//server/share/file.txt", r"\\server\share\file.txt"),
        # Relative paths
        ("relative/path/file.txt", r"relative\path\file.txt"),
        (r"relative\already\windows", r"relative\already\windows"),
        # Plain filename
        ("filename.txt", "filename.txt"),
    ],
)
def test_posix_path_to_windows(posix: str, windows: str):
    assert posix_path_to_windows(posix) == windows


def test_posix_path_to_windows_handles_short_inputs():
    assert posix_path_to_windows("") == ""
    assert posix_path_to_windows("/") == "\\"
    assert posix_path_to_windows("a") == "a"
