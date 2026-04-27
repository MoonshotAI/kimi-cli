from __future__ import annotations

import os
import sys

# Maximum length of the topic snippet rendered in the terminal title. Tabs
# are typically narrow; 40 characters fits while still being descriptive.
_TITLE_TOPIC_MAX = 40


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


def _truncate_topic(topic: str, max_len: int = _TITLE_TOPIC_MAX) -> str:
    """Collapse whitespace and clamp ``topic`` to ``max_len`` chars."""
    flat = " ".join(topic.split())
    if len(flat) <= max_len:
        return flat
    return flat[: max_len - 1].rstrip() + "\u2026"


def compose_session_terminal_title(
    work_dir: str | os.PathLike[str] | None = None,
    topic: str | None = None,
    *,
    base_name: str = "Kimi Code",
) -> str:
    """Compose a terminal tab title that conveys live session context.

    Format: ``"<base>[ \u00b7 <topic>][ \u00b7 <cwd-basename>]"``.

    The intent is to mirror what Copilot CLI and Claude Code do — give
    each tab a stable, human-readable identifier so users with many open
    sessions can find the right one at a glance, while still being
    low-frequency (the topic comes from the session's auto-generated /
    user-set title and only changes at well-defined moments).
    """
    parts: list[str] = [base_name]
    if topic:
        clipped = _truncate_topic(topic)
        if clipped:
            parts.append(clipped)
    if work_dir is not None:
        basename = os.path.basename(os.path.normpath(str(work_dir)))
        if basename:
            parts.append(basename)
    return " \u00b7 ".join(parts)


def update_terminal_title_for_session(
    work_dir: str | os.PathLike[str] | None = None,
    topic: str | None = None,
    *,
    base_name: str = "Kimi Code",
) -> None:
    """Refresh the terminal tab/window title for the live session.

    Safe to call repeatedly; no-ops when stderr is not a TTY.
    """
    set_terminal_title(compose_session_terminal_title(work_dir, topic, base_name=base_name))
