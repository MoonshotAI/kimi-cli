import asyncio
import signal
import sys
from collections.abc import Callable


def install_sigint_handler(loop: asyncio.AbstractEventLoop, handler: Callable[[], None]) -> Callable[[], None]:
    """Install a SIGINT handler that works on Unix and Windows.

    Returns a callable to remove the handler.

    On Unix event loops, prefer ``loop.add_signal_handler``.
    On Windows (or other platforms) where it is not implemented, fall back to
    ``signal.signal``. The fallback cannot be removed from the loop, but we
    restore the previous handler on uninstall.
    """

    try:
        loop.add_signal_handler(signal.SIGINT, handler)  # type: ignore[attr-defined]

        def remove() -> None:
            try:
                loop.remove_signal_handler(signal.SIGINT)  # type: ignore[attr-defined]
            except Exception:
                # Best effort removal; ignore if unsupported
                pass

        return remove
    except (NotImplementedError, RuntimeError):
        # Windows ProactorEventLoop and some environments do not support
        # add_signal_handler. Use synchronous signal handling as a fallback.
        previous = signal.getsignal(signal.SIGINT)
        signal.signal(signal.SIGINT, lambda signum, frame: handler())

        def remove() -> None:
            try:
                signal.signal(signal.SIGINT, previous)  # type: ignore[arg-type]
            except Exception:
                pass

        return remove


