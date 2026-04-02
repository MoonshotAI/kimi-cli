"""Tests for console pager MANPAGER isolation."""

from __future__ import annotations

import contextlib
import os
from unittest.mock import MagicMock, patch

from rich.pager import Pager

from kimi_cli.ui.shell.console import _KimiPager, console


class TestConsolePagerIgnoresManpager:
    """Verify that console.pager() does not use MANPAGER env var.

    MANPAGER is intended for the ``man`` command; pydoc.getpager() reads it
    by default, which causes garbled output when MANPAGER is set to a
    man-specific pipeline such as ``sh -c 'col -bx | bat -l man -p'``.
    """

    def test_pager_context_uses_kimi_pager_by_default(self):
        """console.pager() should inject our custom pager, not SystemPager."""
        ctx = console.pager(styles=True)
        from rich.pager import SystemPager

        assert not isinstance(ctx.pager, SystemPager), (
            "console.pager() should use a custom pager that ignores MANPAGER"
        )

    @patch.dict(os.environ, {"MANPAGER": "sh -c 'col -bx | bat -l man -p'"})
    def test_manpager_stripped_during_pydoc_pager(self):
        """When MANPAGER is set, _KimiPager must strip it before calling pydoc.pager()."""
        pager = _KimiPager()

        def assert_no_manpager(content: str) -> None:
            assert "MANPAGER" not in os.environ, "MANPAGER must be stripped during pydoc.pager()"

        with patch("pydoc.pager", side_effect=assert_no_manpager) as mock_pydoc_pager:
            pager.show("test content")

            mock_pydoc_pager.assert_called_once_with("test content")

    @patch.dict(os.environ, {"MANPAGER": "bat -l man -p"})
    def test_manpager_restored_after_pager_call(self):
        """MANPAGER must be restored after pydoc.pager() returns."""
        pager = _KimiPager()

        with patch("pydoc.pager"):
            pager.show("test content")

        assert os.environ.get("MANPAGER") == "bat -l man -p"

    @patch.dict(os.environ, {"MANPAGER": "bat -l man -p"})
    def test_manpager_restored_on_exception(self):
        """MANPAGER must be restored even if pydoc.pager() raises."""
        pager = _KimiPager()

        with (
            patch("pydoc.pager", side_effect=RuntimeError("boom")),
            contextlib.suppress(RuntimeError),
        ):
            pager.show("test content")

        assert os.environ.get("MANPAGER") == "bat -l man -p"

    def test_manpager_not_set_remains_unset(self):
        """If MANPAGER was never set, it should not appear after show()."""
        env = os.environ.copy()
        env.pop("MANPAGER", None)
        pager = _KimiPager()

        with patch.dict(os.environ, env, clear=True), patch("pydoc.pager"):
            pager.show("test content")
            assert "MANPAGER" not in os.environ

    def test_explicit_pager_argument_honored(self):
        """If caller passes an explicit pager, it should be used as-is."""
        custom = MagicMock(spec=Pager)
        ctx = console.pager(pager=custom, styles=True)
        assert ctx.pager is custom
