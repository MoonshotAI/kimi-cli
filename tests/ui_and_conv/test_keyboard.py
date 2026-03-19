from __future__ import annotations

from kimi_cli.ui.shell.keyboard import KeyEvent, _parse_csi_u


class TestParseCsiU:
    """Tests for Kitty keyboard protocol CSI-u sequence parsing."""

    def test_enter(self) -> None:
        assert _parse_csi_u(b"\x1b[13u") == KeyEvent.ENTER

    def test_tab(self) -> None:
        assert _parse_csi_u(b"\x1b[9u") == KeyEvent.TAB

    def test_escape(self) -> None:
        assert _parse_csi_u(b"\x1b[27u") == KeyEvent.ESCAPE

    def test_space(self) -> None:
        assert _parse_csi_u(b"\x1b[32u") == KeyEvent.SPACE

    def test_enter_with_modifier(self) -> None:
        # Shift+Enter: \x1b[13;2u — keycode should still be recognised
        assert _parse_csi_u(b"\x1b[13;2u") == KeyEvent.ENTER

    def test_enter_with_multiple_params(self) -> None:
        # \x1b[13;1;13u — keycode + modifier + text event
        assert _parse_csi_u(b"\x1b[13;1;13u") == KeyEvent.ENTER

    def test_unknown_keycode(self) -> None:
        assert _parse_csi_u(b"\x1b[97u") is None  # 'a' — not mapped

    def test_not_csi_u_suffix(self) -> None:
        assert _parse_csi_u(b"\x1b[A") is None  # arrow key, not CSI-u

    def test_not_csi_prefix(self) -> None:
        assert _parse_csi_u(b"\x1bOu") is None

    def test_invalid_keycode(self) -> None:
        assert _parse_csi_u(b"\x1b[u") is None

    def test_empty_sequence(self) -> None:
        assert _parse_csi_u(b"") is None
