"""Tests for windows_paths conversion helpers."""

from __future__ import annotations

import pytest

from kimi_cli.utils.windows_paths import (
    posix_path_to_windows,
    windows_path_to_posix,
)


@pytest.mark.parametrize(
    "windows, posix",
    [
        # Drive letters
        (r"C:\Users\foo", "/c/Users/foo"),
        (r"D:\Projects\kimi", "/d/Projects/kimi"),
        (r"c:\users\foo", "/c/users/foo"),  # already lowercase drive
        # Drive root (3 chars: C, :, \)
        ("C:\\", "/c/"),
        # Forward-slash variant on Windows is still valid native input
        ("C:/Users/foo", "/c/Users/foo"),
        # UNC paths
        (r"\\server\share", "//server/share"),
        (r"\\server\share\file.txt", "//server/share/file.txt"),
        # Relative paths
        (r"relative\path\file.txt", "relative/path/file.txt"),
        ("relative/already/posix", "relative/already/posix"),
        # No slashes
        ("filename.txt", "filename.txt"),
    ],
)
def test_windows_path_to_posix(windows: str, posix: str):
    assert windows_path_to_posix(windows) == posix


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


@pytest.mark.parametrize(
    "windows",
    [
        r"C:\Users\foo",
        r"D:\Projects\kimi\src",
        r"\\server\share\file",
    ],
)
def test_round_trip_windows_to_posix_to_windows(windows: str):
    """Round-trip should be idempotent for canonical Windows inputs."""
    assert posix_path_to_windows(windows_path_to_posix(windows)) == windows


@pytest.mark.parametrize(
    "posix",
    [
        "/c/Users/foo",
        "/d/Projects/kimi/src",
        "//server/share/file",
    ],
)
def test_round_trip_posix_to_windows_to_posix(posix: str):
    """Round-trip should be idempotent for canonical POSIX inputs."""
    assert windows_path_to_posix(posix_path_to_windows(posix)) == posix


def test_windows_path_to_posix_does_not_corrupt_relative_with_colon():
    """A path that's not a drive letter should not be misidentified."""
    # `foo:bar` is a malformed path but our drive detection requires `:`
    # at index 1, followed by separator, so this passes through.
    assert windows_path_to_posix("foo:bar") == "foo:bar"


def test_posix_path_to_windows_handles_short_inputs():
    assert posix_path_to_windows("") == ""
    assert posix_path_to_windows("/") == "\\"
    assert posix_path_to_windows("a") == "a"
