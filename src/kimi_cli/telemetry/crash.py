"""Crash telemetry: capture uncaught exceptions via sys.excepthook and
asyncio's exception handler, emit a ``crash`` event, then delegate to the
original handler so the traceback still gets printed.

Privacy: only the exception *class name* is emitted. No message, no stack
trace — those can contain file paths, user input fragments, or URLs.
"""

from __future__ import annotations

import asyncio
import sys
from types import TracebackType
from typing import Any

# ---------------------------------------------------------------------------
# Phase tracking
# ---------------------------------------------------------------------------

_phase: str = "startup"
"""Coarse lifecycle bucket recorded on each crash event.

Valid values: ``startup`` (before app init finishes), ``runtime``
(normal operation), ``shutdown`` (after the main entry point returns).
"""


def set_phase(phase: str) -> None:
    """Update the current lifecycle phase. Called by app entry points."""
    global _phase
    _phase = phase


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def _should_ignore_for_excepthook(exc_type: type[BaseException]) -> bool:
    """Return True for exceptions that are not programming bugs.

    - KeyboardInterrupt: Ctrl+C, already covered by the ``cancel`` event.
    - SystemExit: deliberate exit, not a crash.
    - click.ClickException (UsageError / BadParameter / ...): user-facing
      CLI input errors, not program bugs.
    """
    if issubclass(exc_type, (KeyboardInterrupt, SystemExit)):
        return True
    try:
        import click

        if issubclass(exc_type, click.exceptions.ClickException):
            return True
    except ImportError:
        pass
    return False


# ---------------------------------------------------------------------------
# sys.excepthook
# ---------------------------------------------------------------------------

_original_excepthook: Any = None


def _excepthook(
    exc_type: type[BaseException],
    exc: BaseException,
    tb: TracebackType | None,
) -> None:
    if not _should_ignore_for_excepthook(exc_type):
        # Any failure inside telemetry must not mask the underlying crash.
        try:
            from kimi_cli.telemetry import track

            track(
                "crash",
                error_type=exc_type.__name__,
                where=_phase,
                source="excepthook",
            )
        except Exception:
            pass

    # Always delegate so the traceback is still printed.
    handler = _original_excepthook if _original_excepthook is not None else sys.__excepthook__
    handler(exc_type, exc, tb)


def install_crash_handlers() -> None:
    """Install the process-level ``sys.excepthook``.

    Idempotent: repeated calls are no-ops. Should be called as early as
    possible in the entry point so startup-phase exceptions are captured.
    """
    global _original_excepthook
    if sys.excepthook is _excepthook:
        return
    _original_excepthook = sys.excepthook
    sys.excepthook = _excepthook


# ---------------------------------------------------------------------------
# asyncio exception handler
# ---------------------------------------------------------------------------

_original_asyncio_handler: Any = None


def _asyncio_handler(
    loop: asyncio.AbstractEventLoop,
    context: dict[str, Any],
) -> None:
    exc = context.get("exception")
    # CancelledError during shutdown/cancellation is normal control flow.
    if exc is not None and not isinstance(exc, asyncio.CancelledError):
        try:
            from kimi_cli.telemetry import track

            track(
                "crash",
                error_type=type(exc).__name__,
                where=_phase,
                source="asyncio_task",
            )
        except Exception:
            pass

    # Delegate so the original logging behavior (or custom handler) runs.
    if _original_asyncio_handler is not None:
        _original_asyncio_handler(loop, context)
    else:
        loop.default_exception_handler(context)


def install_asyncio_handler(loop: asyncio.AbstractEventLoop | None = None) -> None:
    """Install the crash handler on the given (or current running) loop.

    Idempotent on the same loop. If a custom handler was already installed,
    it is preserved and still invoked after the crash event is recorded.
    """
    global _original_asyncio_handler
    if loop is None:
        loop = asyncio.get_running_loop()
    current = loop.get_exception_handler()
    if current is _asyncio_handler:
        return
    _original_asyncio_handler = current
    loop.set_exception_handler(_asyncio_handler)
