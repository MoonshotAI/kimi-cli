from __future__ import annotations

import asyncio
import sys
import threading
import time
from collections.abc import AsyncIterator, Callable
from enum import Enum, auto
from typing import TYPE_CHECKING

if TYPE_CHECKING or sys.platform != "win32":
    import termios
if TYPE_CHECKING or sys.platform == "win32":
    import msvcrt


class KeyEvent(Enum):
    UP = auto()
    DOWN = auto()
    LEFT = auto()
    RIGHT = auto()
    ENTER = auto()
    ESCAPE = auto()
    TAB = auto()


async def listen_for_keyboard() -> AsyncIterator[KeyEvent]:
    """Yield `KeyEvent` enums as keys are pressed."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[KeyEvent] = asyncio.Queue()
    cancel_event = threading.Event()

    def _emit(event: KeyEvent) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    listener = threading.Thread(
        target=_listen_for_keyboard_thread,
        args=(cancel_event, _emit),
        daemon=True,
        name="kimi-cli-keyboard-listener",
    )
    listener.start()

    try:
        while True:
            yield await queue.get()
    finally:
        cancel_event.set()
        if listener.is_alive():
            asyncio.get_running_loop().run_in_executor(None, listener.join)


def _listen_for_keyboard_thread(
    cancel: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    if sys.platform == "win32":
        _listen_for_keyboard_windows(cancel, emit)
    else:
        _listen_for_keyboard_unix(cancel, emit)


def _listen_for_keyboard_unix(
    cancel: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    fd = sys.stdin.fileno()
    old_attrs = termios.tcgetattr(fd)
    new_attrs = termios.tcgetattr(fd)

    new_attrs[3] &= ~(termios.ICANON | termios.ECHO)
    new_attrs[6][termios.VMIN] = 0
    new_attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, new_attrs)

    try:
        while not cancel.is_set():
            try:
                char = sys.stdin.read(1)
            except (OSError, ValueError):
                char = ""

            if not char:
                time.sleep(0.01)
                continue

            if char == "\x1b":  # escape sequence
                seq = char
                for _ in range(2):
                    if cancel.is_set():
                        break
                    try:
                        seq += sys.stdin.read(1)
                    except (OSError, ValueError):
                        break
                    if seq in _UNIX_ESC_MAP:
                        break
                event = _UNIX_ESC_MAP.get(seq)
                if event:
                    emit(event)
                elif seq == "\x1b":
                    emit(KeyEvent.ESCAPE)
            elif char in {"\r", "\n"}:
                emit(KeyEvent.ENTER)
            elif char == "\t":
                emit(KeyEvent.TAB)
    finally:
        termios.tcsetattr(fd, termios.TCSAFLUSH, old_attrs)

def _listen_for_keyboard_windows(
    cancel: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    while not cancel.is_set():
        if msvcrt.kbhit():
            ch = msvcrt.getch()

            # extended key?
            if ch in {b"\x00", b"\xe0"}:
                ext = msvcrt.getch()
                if event := _WINDOWS_EXT_MAP.get(ext):
                    emit(event)
            elif ch == b"\x1b":
                emit(KeyEvent.ESCAPE)
            elif ch in {b"\r", b"\n"}:
                emit(KeyEvent.ENTER)
            elif ch == b"\t":
                emit(KeyEvent.TAB)
        else:
            time.sleep(0.005)  # snappy but CPU-friendly


_UNIX_ESC_MAP: dict[str, KeyEvent] = {
    "\x1b[A": KeyEvent.UP,
    "\x1b[B": KeyEvent.DOWN,
    "\x1b[C": KeyEvent.RIGHT,
    "\x1b[D": KeyEvent.LEFT,
}

_WINDOWS_EXT_MAP: dict[bytes, KeyEvent] = {
    b"H": KeyEvent.UP,
    b"P": KeyEvent.DOWN,
    b"M": KeyEvent.RIGHT,
    b"K": KeyEvent.LEFT,
}

if __name__ == "__main__":
    async def _demo() -> None:
        print("Press keys (Ctrl-C to quit)…")
        async for key in listen_for_keyboard():
            print("→", key)

    try:
        asyncio.run(_demo())
    except KeyboardInterrupt:
        pass