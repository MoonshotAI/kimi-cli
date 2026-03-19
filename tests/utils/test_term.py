from __future__ import annotations

from unittest.mock import patch

from kimi_cli.utils.term import disable_kitty_keyboard_protocol


class TestDisableKittyKeyboardProtocol:
    def test_sends_pop_sequence_to_tty(self) -> None:
        with (
            patch("kimi_cli.utils.term.sys.stdout") as mock_stdout,
        ):
            mock_stdout.isatty.return_value = True
            disable_kitty_keyboard_protocol()
            mock_stdout.write.assert_called_once_with("\x1b[<u")
            mock_stdout.flush.assert_called_once()

    def test_skips_non_tty(self) -> None:
        with patch("kimi_cli.utils.term.sys.stdout") as mock_stdout:
            mock_stdout.isatty.return_value = False
            disable_kitty_keyboard_protocol()
            mock_stdout.write.assert_not_called()
