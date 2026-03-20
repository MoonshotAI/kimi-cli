from __future__ import annotations

import os
import sys
from pathlib import Path

_APP_NAME = "Kimi Code"


def _shorten_home(path: str) -> str:
    """Replace the home directory prefix with ``~``."""
    home = str(Path.home())
    if path == home:
        return "~"
    if path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


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


def update_terminal_title_with_cwd(cwd: str | None = None) -> None:
    """Update the terminal title to include the current working directory.

    Format: ``Kimi Code — ~/path/to/project``
    """
    if cwd is None:
        cwd = os.getcwd()
    short_cwd = _shorten_home(cwd)
    set_terminal_title(f"{_APP_NAME} — {short_cwd}")


def init_process_name(name: str = _APP_NAME) -> None:
    """Initialize process name: OS process title + terminal tab title with cwd."""
    set_process_title(name)
    update_terminal_title_with_cwd()
