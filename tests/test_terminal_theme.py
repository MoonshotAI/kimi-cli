"""Tests for terminal theme detection."""

import os

import pytest

from kimi_cli.utils.terminal import detect_terminal_theme, get_code_theme


class TestTerminalTheme:
    """Test terminal theme detection functionality."""

    def test_detect_dark_theme(self, monkeypatch):
        """Test detection of dark terminal theme."""
        # Dark background (0-6, 8)
        monkeypatch.setenv("COLORFGBG", "15;0")
        assert detect_terminal_theme() == "dark"

        monkeypatch.setenv("COLORFGBG", "15;1")
        assert detect_terminal_theme() == "dark"

        monkeypatch.setenv("COLORFGBG", "15;8")
        assert detect_terminal_theme() == "dark"

    def test_detect_light_theme(self, monkeypatch):
        """Test detection of light terminal theme."""
        # Light background (7, 15)
        monkeypatch.setenv("COLORFGBG", "0;7")
        assert detect_terminal_theme() == "light"

        monkeypatch.setenv("COLORFGBG", "0;15")
        assert detect_terminal_theme() == "light"

    def test_detect_theme_no_colorfgbg(self, monkeypatch):
        """Test default to dark theme when COLORFGBG is not set."""
        monkeypatch.delenv("COLORFGBG", raising=False)
        assert detect_terminal_theme() == "dark"

    def test_detect_theme_invalid_colorfgbg(self, monkeypatch):
        """Test default to dark theme when COLORFGBG is invalid."""
        monkeypatch.setenv("COLORFGBG", "invalid")
        assert detect_terminal_theme() == "dark"

        monkeypatch.setenv("COLORFGBG", "15")
        assert detect_terminal_theme() == "dark"

    def test_get_code_theme_dark(self, monkeypatch):
        """Test getting code theme for dark terminal."""
        monkeypatch.setenv("COLORFGBG", "15;0")
        assert get_code_theme() == "monokai"

    def test_get_code_theme_light(self, monkeypatch):
        """Test getting code theme for light terminal."""
        monkeypatch.setenv("COLORFGBG", "0;15")
        assert get_code_theme() == "github-light"

    def test_get_code_theme_default(self, monkeypatch):
        """Test getting code theme when no theme is detected."""
        monkeypatch.delenv("COLORFGBG", raising=False)
        assert get_code_theme() == "monokai"
