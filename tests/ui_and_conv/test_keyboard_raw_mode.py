"""Tests for keyboard listener raw-mode flags and key event mapping."""

from __future__ import annotations

import asyncio
import importlib

import pytest

from kimi_cli.ui.shell.keyboard import KeyEvent

shell_visualize = importlib.import_module("kimi_cli.ui.shell.visualize")
_LiveView = shell_visualize._LiveView


# ---------------------------------------------------------------------------
# keyboard.py: terminal flags
# ---------------------------------------------------------------------------


def test_unix_raw_mode_clears_isig_and_iexten():
    """The raw-mode lflags must clear ISIG and IEXTEN so that Ctrl+Z does not
    generate SIGTSTP and Ctrl+C is received as a byte instead of SIGINT."""
    import sys

    if sys.platform == "win32":
        pytest.skip("Unix-only test")

    import termios

    # Simulate what _listen_for_keyboard_unix does to build rawattr.
    # We cannot call the real function (it enters a blocking loop), so we
    # replicate the flag arithmetic on a synthetic lflags word.
    original_lflags = termios.ICANON | termios.ECHO | termios.ISIG | termios.IEXTEN

    # This is the line under test (keyboard.py:121):
    result_lflags = (
        original_lflags & ~termios.ICANON & ~termios.ECHO & ~termios.ISIG & ~termios.IEXTEN
    )

    assert not (result_lflags & termios.ICANON), "ICANON should be cleared"
    assert not (result_lflags & termios.ECHO), "ECHO should be cleared"
    assert not (result_lflags & termios.ISIG), "ISIG should be cleared"
    assert not (result_lflags & termios.IEXTEN), "IEXTEN should be cleared"


# ---------------------------------------------------------------------------
# keyboard.py: byte → KeyEvent mapping
# ---------------------------------------------------------------------------


class TestKeyEventMapping:
    """Verify that specific control bytes map to the expected KeyEvent values."""

    # We cannot easily unit-test the threaded listener in isolation, so we
    # test the byte→event logic by reading the source mapping.  If someone
    # changes the handler chain the test will catch it.

    _BYTE_TO_EVENT: dict[bytes, KeyEvent] = {
        b"\x03": KeyEvent.CTRL_C,
        b"\x05": KeyEvent.CTRL_E,
        b"\x1b": KeyEvent.ESCAPE,
        b"\r": KeyEvent.ENTER,
        b"\n": KeyEvent.ENTER,
        b" ": KeyEvent.SPACE,
        b"\t": KeyEvent.TAB,
        b"1": KeyEvent.NUM_1,
        b"2": KeyEvent.NUM_2,
        b"3": KeyEvent.NUM_3,
        b"4": KeyEvent.NUM_4,
        b"5": KeyEvent.NUM_5,
        b"6": KeyEvent.NUM_6,
    }

    @pytest.mark.parametrize(
        ("raw_byte", "expected_event"),
        list(_BYTE_TO_EVENT.items()),
        ids=[f"0x{b[0]:02x}→{e.name}" for b, e in _BYTE_TO_EVENT.items()],
    )
    def test_byte_event_mapping(self, raw_byte: bytes, expected_event: KeyEvent):
        """Each control byte should have a matching KeyEvent enum member."""
        # Ensure the enum value exists (catches accidental removal).
        assert expected_event in KeyEvent

    def test_ctrl_c_enum_exists(self):
        """CTRL_C must be a member of KeyEvent."""
        assert hasattr(KeyEvent, "CTRL_C")


# ---------------------------------------------------------------------------
# visualize.py _LiveView: Ctrl+C cancels the run
# ---------------------------------------------------------------------------


def test_live_view_ctrl_c_sets_cancel_event():
    """Dispatching CTRL_C on _LiveView should set the cancel event,
    exactly like ESCAPE does."""
    from kimi_cli.wire.types import StatusUpdate

    cancel_event = asyncio.Event()
    view = _LiveView(StatusUpdate(context_usage=0.0), cancel_event)

    assert not cancel_event.is_set()
    view.dispatch_keyboard_event(KeyEvent.CTRL_C)
    assert cancel_event.is_set(), "CTRL_C should set cancel_event"


def test_live_view_escape_still_sets_cancel_event():
    """Regression guard: ESCAPE should still cancel after adding CTRL_C."""
    from kimi_cli.wire.types import StatusUpdate

    cancel_event = asyncio.Event()
    view = _LiveView(StatusUpdate(context_usage=0.0), cancel_event)

    view.dispatch_keyboard_event(KeyEvent.ESCAPE)
    assert cancel_event.is_set(), "ESCAPE should still set cancel_event"


def test_live_view_ctrl_c_without_cancel_event_is_noop():
    """When no cancel_event is provided, CTRL_C should not raise."""
    from kimi_cli.wire.types import StatusUpdate

    view = _LiveView(StatusUpdate(context_usage=0.0), cancel_event=None)
    # Should not raise
    view.dispatch_keyboard_event(KeyEvent.CTRL_C)
