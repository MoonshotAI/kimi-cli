from __future__ import annotations

import asyncio
import contextlib
import signal
from collections.abc import Callable


def install_sigint_handler(
    loop: asyncio.AbstractEventLoop, handler: Callable[[], None]
) -> Callable[[], None]:
    """
    Install a SIGINT handler that works on Unix and Windows.

    On Unix event loops, prefer `loop.add_signal_handler`.
    On Windows (or other platforms) where it is not implemented, fall back to
    `signal.signal`. The fallback cannot be removed from the loop, but we
    restore the previous handler on uninstall.

    Returns:
        A function that removes the installed handler. It is guaranteed that
        no exceptions are raised when calling the returned function.
    """

    try:
        loop.add_signal_handler(signal.SIGINT, handler)

        def remove() -> None:
            with contextlib.suppress(RuntimeError):
                loop.remove_signal_handler(signal.SIGINT)

        return remove
    except RuntimeError:
        # Windows ProactorEventLoop and some environments do not support
        # add_signal_handler. Use synchronous signal handling as a fallback.
        previous = signal.getsignal(signal.SIGINT)
        signal.signal(signal.SIGINT, lambda signum, frame: handler())

        def remove() -> None:
            with contextlib.suppress(RuntimeError):
                signal.signal(signal.SIGINT, previous)

        return remove
