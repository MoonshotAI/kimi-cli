from __future__ import annotations

import sys


def set_process_title(title: str) -> None:
    """Set the OS-level process title visible in ps/top/terminal panels."""
    try:
        import setproctitle

        setproctitle.setproctitle(title)
    except ImportError:
        pass


def set_terminal_title(title: str) -> None:
    """Set the terminal tab/window title via ANSI OSC escape sequence.

    Only writes when stderr is a TTY to avoid polluting piped output.
    """
    if not sys.stderr.isatty():
        return
    try:
        sys.stderr.write(f"\033]0;{title}\007")
        sys.stderr.flush()
    except OSError:
        pass


def init_process_name(name: str = "Kimi Code") -> None:
    """Initialize process name: OS process title + terminal tab title."""
    set_process_title(name)
    set_terminal_title(name)
