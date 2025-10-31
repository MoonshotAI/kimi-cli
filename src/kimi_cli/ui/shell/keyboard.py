import asyncio
import sys
import threading
import time
from collections.abc import AsyncGenerator, Callable
from enum import Enum, auto


class KeyEvent(Enum):
    UP = auto()
    DOWN = auto()
    LEFT = auto()
    RIGHT = auto()
    ENTER = auto()
    ESCAPE = auto()
    TAB = auto()


async def listen_for_keyboard() -> AsyncGenerator[KeyEvent]:
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue[KeyEvent]()
    cancel_event = threading.Event()

    def emit(event: KeyEvent) -> None:
        # print(f"emit: {event}")
        loop.call_soon_threadsafe(queue.put_nowait, event)

    listener = threading.Thread(
        target=_listen_for_keyboard_thread,
        args=(cancel_event, emit),
        name="kimi-cli-keyboard-listener",
        daemon=True,
    )
    listener.start()

    try:
        while True:
            yield await queue.get()
    finally:
        cancel_event.set()
        if listener.is_alive():
            await asyncio.to_thread(listener.join)


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
    if sys.platform == "win32":
        raise RuntimeError("Unix keyboard listener requires a non-Windows platform")

    import termios

    # make stdin raw and non-blocking
    fd = sys.stdin.fileno()
    oldterm = termios.tcgetattr(fd)
    newattr = termios.tcgetattr(fd)
    newattr[3] = newattr[3] & ~termios.ICANON & ~termios.ECHO
    newattr[6][termios.VMIN] = 0
    newattr[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, newattr)

    try:
        while not cancel.is_set():
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
    finally:
        # restore the terminal settings
        termios.tcsetattr(fd, termios.TCSAFLUSH, oldterm)


def _listen_for_keyboard_windows(
    cancel: threading.Event,
    emit: Callable[[KeyEvent], None],
) -> None:
    if sys.platform != "win32":
        raise RuntimeError("Windows keyboard listener requires a Windows platform")

    import msvcrt

    while not cancel.is_set():
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
