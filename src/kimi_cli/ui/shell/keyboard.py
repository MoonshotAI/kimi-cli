import asyncio
import sys
import termios
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
                c = sys.stdin.read(1)
            except (OSError, ValueError):
                c = ""

            if not c:
                if cancel.is_set():
                    break
                time.sleep(0.01)
                continue

            if c == "\x1b":
                sequence = c
                for _ in range(2):
                    if cancel.is_set():
                        break
                    try:
                        fragment = sys.stdin.read(1)
                    except (OSError, ValueError):
                        fragment = ""
                    if not fragment:
                        break
                    sequence += fragment
                    if sequence in _ARROW_KEY_MAP:
                        break

                event = _ARROW_KEY_MAP.get(sequence)
                if event is not None:
                    emit(event)
                elif sequence == "\x1b":
                    emit(KeyEvent.ESCAPE)
            elif c in ("\r", "\n"):
                emit(KeyEvent.ENTER)
            elif c == "\t":
                emit(KeyEvent.TAB)
    finally:
        # restore the terminal settings
        termios.tcsetattr(fd, termios.TCSAFLUSH, oldterm)


_ARROW_KEY_MAP: dict[str, KeyEvent] = {
    "\x1b[A": KeyEvent.UP,
    "\x1b[B": KeyEvent.DOWN,
    "\x1b[C": KeyEvent.RIGHT,
    "\x1b[D": KeyEvent.LEFT,
}


if __name__ == "__main__":

    async def dev_main():
        async for event in listen_for_keyboard():
            print(event)

    asyncio.run(dev_main())
