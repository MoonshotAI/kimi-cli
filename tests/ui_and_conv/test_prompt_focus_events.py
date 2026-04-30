from __future__ import annotations

from prompt_toolkit.input.vt100_parser import Vt100Parser
from prompt_toolkit.key_binding.key_processor import KeyPress
from prompt_toolkit.keys import Keys

from kimi_cli.ui.shell.prompt import _register_xterm_focus_event_sequences


def _parse_vt100(data: str) -> list[KeyPress]:
    key_presses: list[KeyPress] = []
    parser = Vt100Parser(key_presses.append)
    parser.feed(data)
    parser.flush()
    return key_presses


def test_xterm_focus_event_sequences_are_ignored():
    """xterm focus in/out reports should not leak into the prompt buffer."""
    _register_xterm_focus_event_sequences()

    for sequence in ("\x1b[I", "\x1b[O"):
        key_presses = _parse_vt100(sequence)

        assert len(key_presses) == 1
        assert key_presses[0].key == Keys.Ignore
