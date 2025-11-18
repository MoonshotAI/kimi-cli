from __future__ import annotations

import os
import re
import sys
import time


def ensure_new_line() -> None:
    """Ensure the next prompt starts at column 0 regardless of prior command output."""

    if not sys.stdout.isatty() or not sys.stdin.isatty():
        return

    needs_break = True
    if sys.platform == "win32":
        column = _cursor_column_windows()
        needs_break = column not in (None, 0)
    else:
        column = _cursor_column_unix()
        needs_break = column not in (None, 1)

    if needs_break:
        _write_newline()


def _cursor_column_unix() -> int | None:
    assert sys.platform != "win32"

    import select
    import termios
    import tty

    _CURSOR_QUERY = "\x1b[6n"
    _CURSOR_POSITION_RE = re.compile(r"\x1b\[(\d+);(\d+)R")

    fd = sys.stdin.fileno()
    oldterm = termios.tcgetattr(fd)

    try:
        tty.setcbreak(fd)
        sys.stdout.write(_CURSOR_QUERY)
        sys.stdout.flush()

        response = ""
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline:
            timeout = max(0.01, deadline - time.monotonic())
            ready, _, _ = select.select([sys.stdin], [], [], timeout)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 32)
            except OSError:
                break
            if not chunk:
                break
            response += chunk.decode(encoding="utf-8", errors="ignore")
            match = _CURSOR_POSITION_RE.search(response)
            if match:
                return int(match.group(2))
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, oldterm)

    return None


def _cursor_column_windows() -> int | None:
    assert sys.platform == "win32"

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    _STD_OUTPUT_HANDLE = -11  # Windows API constant for standard output handle
    handle = kernel32.GetStdHandle(_STD_OUTPUT_HANDLE)
    invalid_handle_value = ctypes.c_void_p(-1).value
    if handle in (0, invalid_handle_value):
        return None

    class COORD(ctypes.Structure):
        _fields_ = [("X", wintypes.SHORT), ("Y", wintypes.SHORT)]

    class SMALL_RECT(ctypes.Structure):
        _fields_ = [
            ("Left", wintypes.SHORT),
            ("Top", wintypes.SHORT),
            ("Right", wintypes.SHORT),
            ("Bottom", wintypes.SHORT),
        ]

    class CONSOLE_SCREEN_BUFFER_INFO(ctypes.Structure):
        _fields_ = [
            ("dwSize", COORD),
            ("dwCursorPosition", COORD),
            ("wAttributes", wintypes.WORD),
            ("srWindow", SMALL_RECT),
            ("dwMaximumWindowSize", COORD),
        ]

    csbi = CONSOLE_SCREEN_BUFFER_INFO()
    if not kernel32.GetConsoleScreenBufferInfo(handle, ctypes.byref(csbi)):
        return None

    return int(csbi.dwCursorPosition.X)


def _write_newline() -> None:
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    print("test", end="", flush=True)
    ensure_new_line()
    print("next line")
