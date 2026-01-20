from __future__ import annotations

import asyncio
import sys
import threading
import time
from collections.abc import AsyncGenerator, Callable
from enum import Enum, auto

from kimi_cli.utils.aioqueue import Queue


class KeyEvent(Enum):
    UP = auto()
    DOWN = auto()
    LEFT = auto()
    RIGHT = auto()
    ENTER = auto()
    ESCAPE = auto()
    TAB = auto()
    CTRL_E = auto()


class KeyboardListener:
    def __init__(self) -> None:
        self._queue = Queue[KeyEvent]()
        self._cancel_event = threading.Event()
        self._pause_event = threading.Event()
        self._paused_event = threading.Event()
        self._listener: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> None:
        if self._listener is not None:
            return
        self._loop = asyncio.get_running_loop()

        def emit(event: KeyEvent) -> None:
            if self._loop is None:
                return
            self._loop.call_soon_threadsafe(self._queue.put_nowait, event)

        self._listener = threading.Thread(
            target=_listen_for_keyboard_thread,
            args=(self._cancel_event, self._pause_event, self._paused_event, emit),
            name="kimi-cli-keyboard-listener",
            daemon=True,
        )
        self._listener.start()

    async def stop(self) -> None:
        self._cancel_event.set()
        self._pause_event.clear()
        if self._listener and self._listener.is_alive():
            await asyncio.to_thread(self._listener.join)

    def _pause_sync(self) -> None:
        self._pause_event.set()
        self._paused_event.wait()

    async def pause(self) -> None:
        await asyncio.to_thread(self._pause_sync)

    def _resume_sync(self) -> None:
        self._pause_event.clear()
        while self._paused_event.is_set() and not self._cancel_event.is_set():
            time.sleep(0.01)

    async def resume(self) -> None:
        await asyncio.to_thread(self._resume_sync)

    async def get(self) -> KeyEvent:
        return await self._queue.get()


async def listen_for_keyboard() -> AsyncGenerator[KeyEvent]:
    listener = KeyboardListener()
    await listener.start()

    try:
        while True:
            yield await listener.get()
    finally:
        await listener.stop()


def _listen_for_keyboard_thread(
    cancel: threading.Event,
    pause: threading.Event,
    paused: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    if sys.platform == "win32":
        _listen_for_keyboard_windows(cancel, pause, paused, emit)
    else:
        _listen_for_keyboard_unix(cancel, pause, paused, emit)


def _listen_for_keyboard_unix(
    cancel: threading.Event,
    pause: threading.Event,
    paused: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    if sys.platform == "win32":
        raise RuntimeError("Unix keyboard listener requires a non-Windows platform")

    import termios

    fd = sys.stdin.fileno()
    oldterm = termios.tcgetattr(fd)
    rawattr = termios.tcgetattr(fd)
    rawattr[3] = rawattr[3] & ~termios.ICANON & ~termios.ECHO
    rawattr[6][termios.VMIN] = 0
    rawattr[6][termios.VTIME] = 0
    raw_enabled = False

    def enable_raw() -> None:
        nonlocal raw_enabled
        if raw_enabled:
            return
        termios.tcsetattr(fd, termios.TCSANOW, rawattr)
        raw_enabled = True

    def disable_raw() -> None:
        nonlocal raw_enabled
        if not raw_enabled:
            return
        termios.tcsetattr(fd, termios.TCSANOW, oldterm)
        raw_enabled = False

    enable_raw()

    try:
        while not cancel.is_set():
            if pause.is_set():
                disable_raw()
                paused.set()
                time.sleep(0.01)
                continue
            if paused.is_set():
                paused.clear()
                enable_raw()

            try:
                c = sys.stdin.buffer.read(1)
            except (OSError, ValueError):
                c = b""

            if not c:
                if cancel.is_set():
                    break
                time.sleep(0.01)
                continue

            if c == b"\x1b":
                sequence = c
                for _ in range(2):
                    if cancel.is_set():
                        break
                    try:
                        fragment = sys.stdin.buffer.read(1)
                    except (OSError, ValueError):
                        fragment = b""
                    if not fragment:
                        break
                    sequence += fragment
                    if sequence in _ARROW_KEY_MAP:
                        break

                event = _ARROW_KEY_MAP.get(sequence)
                if event is not None:
                    emit(event)
                elif sequence == b"\x1b":
                    emit(KeyEvent.ESCAPE)
            elif c in (b"\r", b"\n"):
                emit(KeyEvent.ENTER)
            elif c == b"\t":
                emit(KeyEvent.TAB)
            elif c == b"\x05":  # Ctrl+E
                emit(KeyEvent.CTRL_E)
    finally:
        termios.tcsetattr(fd, termios.TCSAFLUSH, oldterm)


def _listen_for_keyboard_windows(
    cancel: threading.Event,
    pause: threading.Event,
    paused: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    if sys.platform != "win32":
        raise RuntimeError("Windows keyboard listener requires a Windows platform")

    import msvcrt

    while not cancel.is_set():
        if pause.is_set():
            paused.set()
            time.sleep(0.01)
            continue
        if paused.is_set():
            paused.clear()

        if msvcrt.kbhit():
            c = msvcrt.getch()

            # Handle special keys (arrow keys, etc.)
            if c in (b"\x00", b"\xe0"):
                # Extended key, read the next byte
                extended = msvcrt.getch()
                event = _WINDOWS_KEY_MAP.get(extended)
                if event is not None:
                    emit(event)
            elif c == b"\x1b":
                sequence = c
                for _ in range(2):
                    if cancel.is_set():
                        break
                    fragment = msvcrt.getch() if msvcrt.kbhit() else b""
                    if not fragment:
                        break
                    sequence += fragment
                    if sequence in _ARROW_KEY_MAP:
                        break

                event = _ARROW_KEY_MAP.get(sequence)
                if event is not None:
                    emit(event)
                elif sequence == b"\x1b":
                    emit(KeyEvent.ESCAPE)
            elif c in (b"\r", b"\n"):
                emit(KeyEvent.ENTER)
            elif c == b"\t":
                emit(KeyEvent.TAB)
            elif c == b"\x05":  # Ctrl+E
                emit(KeyEvent.CTRL_E)
        else:
            if cancel.is_set():
                break
            time.sleep(0.01)


_ARROW_KEY_MAP: dict[bytes, KeyEvent] = {
    b"\x1b[A": KeyEvent.UP,
    b"\x1b[B": KeyEvent.DOWN,
    b"\x1b[C": KeyEvent.RIGHT,
    b"\x1b[D": KeyEvent.LEFT,
}

_WINDOWS_KEY_MAP: dict[bytes, KeyEvent] = {
    b"H": KeyEvent.UP,  # Up arrow
    b"P": KeyEvent.DOWN,  # Down arrow
    b"M": KeyEvent.RIGHT,  # Right arrow
    b"K": KeyEvent.LEFT,  # Left arrow
}


if __name__ == "__main__":

    async def dev_main():
        async for event in listen_for_keyboard():
            print(event)

    asyncio.run(dev_main())
