"""Tests for Shift+Enter newline support in the interactive prompt."""

from __future__ import annotations

from prompt_toolkit.input.ansi_escape_sequences import ANSI_SEQUENCES

# Import the module under test so its module-level side effects run.
import kimi_cli.ui.shell.prompt as _prompt_module


class TestShiftEnterAnsiSequences:
    """Verify that modified Enter ANSI sequences are registered at import time."""

    def test_xterm_modifyotherkeys_shift_enter_registered(self) -> None:
        """Shift+Enter is mapped to a private-use character so it can be bound
        independently of the plain Enter key. This preserves newline insertion
        even when the completion menu is open.
        """
        seq = "\x1b[27;2;13~"
        assert seq in ANSI_SEQUENCES
        assert ANSI_SEQUENCES[seq] == "\ue001"

    def test_xterm_modifyotherkeys_alt_enter_registered(self) -> None:
        """Alt+Enter is mapped to a private-use character so it can be bound
        independently of the plain Enter key. This preserves the existing
        behaviour where Alt+Enter inserts a newline even when the completion
        menu is open.
        """
        seq = "\x1b[27;3;13~"
        assert seq in ANSI_SEQUENCES
        assert ANSI_SEQUENCES[seq] == "\ue000"

    def test_kitty_sequence_is_not_registered(self) -> None:
        """The kitty keyboard protocol is intentionally not enabled because
        it changes encoding for many modified keys and prompt_toolkit only
        recognises a subset of CSI-u sequences. Using it would risk breaking
        shortcuts like Ctrl-X, Ctrl-O and Ctrl-V on kitty-protocol terminals.
        """
        assert "\x1b[13;2u" not in ANSI_SEQUENCES

    def test_sequences_are_idempotent_on_reimport(self) -> None:
        """Re-importing the module must not raise or change the mapping."""
        import importlib

        importlib.reload(_prompt_module)

        assert ANSI_SEQUENCES["\x1b[27;2;13~"] == "\ue001"
        assert ANSI_SEQUENCES["\x1b[27;3;13~"] == "\ue000"
