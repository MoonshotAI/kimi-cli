"""Tests for normalize_user_path — the entry-side path adapter for file tools."""

from __future__ import annotations

import platform

import pytest

from kimi_cli.utils.path import normalize_user_path


@pytest.fixture
def mock_windows(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")


@pytest.fixture
def mock_linux(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Linux")


class TestOnWindows:
    def test_msys_drive_path_converted(self, mock_windows):
        assert normalize_user_path("/c/Users/foo/file.txt") == r"C:\Users\foo\file.txt"

    def test_msys_drive_root_converted(self, mock_windows):
        assert normalize_user_path("/c/") == "C:\\"

    def test_uppercase_drive_letter_normalized(self, mock_windows):
        assert normalize_user_path("/C/Users/foo") == r"C:\Users\foo"

    def test_cygdrive_form_converted(self, mock_windows):
        assert normalize_user_path("/cygdrive/c/Users/foo") == r"C:\Users\foo"

    def test_unc_path_converted(self, mock_windows):
        assert normalize_user_path("//server/share/file") == r"\\server\share\file"

    def test_already_native_windows_unchanged(self, mock_windows):
        assert normalize_user_path(r"C:\Users\foo") == r"C:\Users\foo"
        assert normalize_user_path(r"D:\Projects") == r"D:\Projects"

    def test_relative_path_unchanged(self, mock_windows):
        assert normalize_user_path("relative/path") == "relative/path"
        assert normalize_user_path(r"relative\path") == r"relative\path"
        assert normalize_user_path("file.txt") == "file.txt"

    def test_tilde_unchanged(self, mock_windows):
        # ~ is expanded later by KaosPath.expanduser(); normalize_user_path doesn't touch it.
        assert normalize_user_path("~/Documents") == "~/Documents"

    def test_single_root_slash_unchanged(self, mock_windows):
        # Just `/` doesn't match any drive pattern; safer to leave alone.
        assert normalize_user_path("/") == "/"


class TestOnNonWindows:
    def test_msys_path_passthrough_on_linux(self, mock_linux):
        # /c/Users/foo could be a real Linux path; do not mangle it.
        assert normalize_user_path("/c/Users/foo") == "/c/Users/foo"

    def test_unc_passthrough_on_linux(self, mock_linux):
        assert normalize_user_path("//server/share") == "//server/share"

    def test_native_paths_passthrough_on_linux(self, mock_linux):
        assert normalize_user_path("/usr/local/bin") == "/usr/local/bin"
        assert normalize_user_path("relative/path") == "relative/path"
