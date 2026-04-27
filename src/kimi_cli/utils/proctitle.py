from __future__ import annotations

import os
import sys

# Maximum length of the short session id rendered in titles. Eight hex chars
# is plenty for visual disambiguation while keeping process titles compact
# (Windows Task Manager and macOS `ps` both truncate aggressively).
_SHORT_SESSION_ID_LEN = 8


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


def _short_session_id(session_id: str) -> str:
    """Return a short, display-friendly version of a session id.

    Strips dashes (uuid-style) and truncates to ``_SHORT_SESSION_ID_LEN``
    characters so the resulting tag fits comfortably in process titles.
    """
    compact = session_id.replace("-", "")
    return compact[:_SHORT_SESSION_ID_LEN] or session_id


def _sanitize_proctitle_token(value: str) -> str:
    """Make ``value`` safe to embed in a ``key=value`` process-title token.

    Whitespace and ``=`` would break naive split-on-whitespace parsing by
    external observers, so both are replaced with ``_``. All other Unicode,
    including non-ASCII path components, is preserved verbatim.
    """
    chars: list[str] = []
    for ch in value:
        if ch.isspace() or ch == "=":
            chars.append("_")
        else:
            chars.append(ch)
    return "".join(chars)


def compose_session_process_title(
    session_id: str,
    work_dir: str | os.PathLike[str] | None = None,
    *,
    base_name: str = "kimi-code",
) -> str:
    """Compose an OS process title that encodes the live session identity.

    Format: ``"<base> session=<short-id>[ cwd=<basename>]"``.

    External tools (terminal multiplexers, tab managers, IDE integrations)
    can read this from ``ps``/Task Manager and reliably map a running
    process to its session — even when the session was created without an
    explicit ``--session`` flag, which is the common case.

    The ``key=value`` token form is intentional: it parses with simple
    splits and avoids ambiguity if user-facing branding changes. To keep
    that contract intact, whitespace and ``=`` inside the cwd basename are
    replaced with ``_`` via :func:`_sanitize_proctitle_token`; otherwise a
    repository under, say, ``.../John Doe/`` would yield ``cwd=John Doe``
    and break naive token parsing.
    """
    parts: list[str] = [
        base_name,
        f"session={_sanitize_proctitle_token(_short_session_id(session_id))}",
    ]
    if work_dir is not None:
        basename = os.path.basename(os.path.normpath(str(work_dir)))
        if basename:
            parts.append(f"cwd={_sanitize_proctitle_token(basename)}")
    return " ".join(parts)


def set_session_process_title(
    session_id: str,
    work_dir: str | os.PathLike[str] | None = None,
    *,
    base_name: str = "kimi-code",
) -> None:
    """Set the OS process title to encode the live session identity.

    Convenience wrapper around :func:`set_process_title` that uses
    :func:`compose_session_process_title` to build a stable, parseable
    title containing the session id.
    """
    set_process_title(compose_session_process_title(session_id, work_dir, base_name=base_name))
