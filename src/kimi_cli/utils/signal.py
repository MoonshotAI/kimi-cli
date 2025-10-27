"""Cross-platform signal handling utilities."""

import asyncio
from collections.abc import Callable
from platform import system


def add_signal_handler_if_supported(
    sig: int,
    handler: Callable[[], None],
    loop: asyncio.AbstractEventLoop,
) -> bool:
    """Add signal handler if supported on current platform.

    Args:
        sig: Signal number (e.g., signal.SIGINT)
        handler: Handler function to call
        loop: Event loop to add handler to

    Returns:
        bool: True if handler was added, False if not supported
    """
    if system() != "Windows":
        try:
            loop.add_signal_handler(sig, handler)
            return True
        except (AttributeError, NotImplementedError):
            return False
    return False


def remove_signal_handler_if_supported(sig: int, loop: asyncio.AbstractEventLoop) -> bool:
    """Remove signal handler if supported on current platform.

    Args:
        sig: Signal number to remove
        loop: Event loop to remove handler from

    Returns:
        bool: True if handler was removed, False if not supported
    """
    if system() != "Windows":
        try:
            loop.remove_signal_handler(sig)
            return True
        except (AttributeError, NotImplementedError):
            return False
    return False


def create_sigint_handler(cancel_event: asyncio.Event) -> Callable[[], None]:
    """Create a SIGINT handler that sets a cancel event.

    Args:
        cancel_event: Event to set when SIGINT is received

    Returns:
        Handler function
    """

    def handler() -> None:
        cancel_event.set()

    return handler
