"""Runtime status file for an active interactive Kimi session.

This module writes a small JSON file at ``<session_dir>/runtime.json`` while
an interactive Kimi session is alive, and removes it on shutdown. It exists
so that **external** tools (terminal multiplexers, tab managers, IDE
integrations, observability daemons) can answer the question:

    "Which Kimi session is the running PID X serving?"

The CLI does not embed the session id in ``argv`` for fresh (non-resumed)
sessions, and the OS process title can be truncated, so a side-channel file
that records the explicit ``(pid, session_id, work_dir, ...)`` tuple is the
most reliable cross-platform signal.

The file is written atomically and contains a small, stable schema. External
consumers should treat unknown fields as forward-compatible additions.
"""

from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import cast

from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

RUNTIME_STATUS_FILENAME = "runtime.json"
RUNTIME_STATUS_SCHEMA_VERSION = 1


@dataclass(slots=True, kw_only=True)
class RuntimeStatus:
    """Snapshot of a live Kimi session process for external observers."""

    schema_version: int
    pid: int
    session_id: str
    work_dir: str
    hostname: str
    started_at: float
    kimi_version: str | None


def _runtime_status_path(session_dir: Path) -> Path:
    return session_dir / RUNTIME_STATUS_FILENAME


def _safe_kimi_version() -> str | None:
    try:
        from kimi_cli.constant import get_version

        return get_version()
    except Exception:
        return None


def write_runtime_status(
    session_dir: Path,
    *,
    session_id: str,
    work_dir: str,
    pid: int | None = None,
) -> Path:
    """Atomically write the runtime status file for this session.

    Writes ``<session_dir>/runtime.json`` via tmp-file + ``os.replace`` so
    an external observer never sees a partially written file: it sees
    either the previous contents or the fully committed new contents.

    Returns the path of the file that was written. Exceptions from the
    underlying I/O (``OSError``, ``PermissionError``, read-only
    filesystem, etc.) propagate to the caller; this function does not
    log or swallow them. Callers that want best-effort semantics should
    wrap the call in ``contextlib.suppress(OSError)``. On failure, no
    leftover ``.tmp`` file is kept on disk.
    """
    status = RuntimeStatus(
        schema_version=RUNTIME_STATUS_SCHEMA_VERSION,
        pid=pid if pid is not None else os.getpid(),
        session_id=session_id,
        work_dir=work_dir,
        hostname=socket.gethostname(),
        started_at=time.time(),
        kimi_version=_safe_kimi_version(),
    )
    target = _runtime_status_path(session_dir)
    atomic_json_write(asdict(status), target)
    return target


def clear_runtime_status(session_dir: Path) -> None:
    """Remove the runtime status file for this session, if present.

    Safe to call multiple times and on directories that no longer exist.
    """
    target = _runtime_status_path(session_dir)
    try:
        target.unlink(missing_ok=True)
    except OSError:
        logger.debug("Failed to remove runtime status file {file}", file=target)


def read_runtime_status(session_dir: Path) -> RuntimeStatus | None:
    """Read the runtime status file from a session directory, if present.

    Returns ``None`` if the file is missing, malformed, or written by a
    schema version this code does not understand.
    """
    target = _runtime_status_path(session_dir)
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        logger.debug("Failed to read runtime status file {file}", file=target)
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.debug("Malformed runtime status file {file}", file=target)
        return None

    if not isinstance(data, dict):
        return None
    parsed = cast(dict[str, object], data)
    if parsed.get("schema_version") != RUNTIME_STATUS_SCHEMA_VERSION:
        return None

    try:
        return RuntimeStatus(
            schema_version=int(parsed["schema_version"]),  # type: ignore[arg-type]
            pid=int(parsed["pid"]),  # type: ignore[arg-type]
            session_id=str(parsed["session_id"]),
            work_dir=str(parsed["work_dir"]),
            hostname=str(parsed["hostname"]),
            started_at=float(parsed["started_at"]),  # type: ignore[arg-type]
            kimi_version=(
                None if parsed.get("kimi_version") is None else str(parsed["kimi_version"])
            ),
        )
    except (KeyError, TypeError, ValueError):
        logger.debug("Incomplete runtime status file {file}", file=target)
        return None
