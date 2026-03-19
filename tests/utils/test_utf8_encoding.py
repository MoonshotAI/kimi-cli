"""Tests for UTF-8 encoding enforcement on Windows.

Regression tests for issue #773: on Windows with a legacy ANSI code page,
printing emoji prompt symbols (✨, 💫, 📋) crashes with
'ascii' codec can't encode characters.
"""

from __future__ import annotations

import io
import sys
from unittest.mock import patch

import pytest


class TestEnsureUtf8Stdio:
    """Test _ensure_utf8_stdio from __main__."""

    def test_noop_on_non_windows(self) -> None:
        """Should do nothing on non-Windows platforms."""
        from kimi_cli.__main__ import _ensure_utf8_stdio

        with patch.object(sys, "platform", "linux"):
            # Should return without touching streams
            _ensure_utf8_stdio()

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows-only test")
    def test_reconfigures_ascii_stdout_on_windows(self) -> None:
        """stdout should be reconfigured to UTF-8 when defaulting to ASCII."""
        from kimi_cli.__main__ import _ensure_utf8_stdio

        buf = io.BytesIO()
        fake_stdout = io.TextIOWrapper(buf, encoding="ascii")
        with patch.object(sys, "stdout", fake_stdout), patch.object(sys, "platform", "win32"):
            _ensure_utf8_stdio()
            assert sys.stdout.encoding.lower().replace("-", "") == "utf8"

    def test_skips_when_already_utf8(self) -> None:
        """Should not touch streams already using UTF-8."""
        from kimi_cli.__main__ import _ensure_utf8_stdio

        buf = io.BytesIO()
        fake_stdout = io.TextIOWrapper(buf, encoding="utf-8")
        original_stdout = sys.stdout
        with patch.object(sys, "stdout", fake_stdout), patch.object(sys, "platform", "win32"):
            _ensure_utf8_stdio()
            # The wrapper should remain the same object (not replaced)
            assert sys.stdout is fake_stdout


class TestConsoleEncoding:
    """Test that the Rich console can handle emoji and CJK without errors."""

    def test_console_prints_emoji(self) -> None:
        """Console must render prompt emoji without UnicodeEncodeError."""
        from kimi_cli.ui.shell.console import console

        buf = io.StringIO()
        # Render to a string buffer to verify no encoding crash
        with console.capture() as capture:
            console.print("✨ 💫 📋 Hello 你好")
        output = capture.get()
        assert "✨" in output
        assert "你好" in output
