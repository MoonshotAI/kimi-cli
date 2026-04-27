"""Runtime status file for an active interactive Kimi session.

This module writes two cooperating sidecar files while an interactive Kimi
session is alive, and removes them on shutdown. They exist so that
**external** tools (terminal multiplexers, tab managers, IDE integrations,
observability daemons) can answer the question:

    "Which Kimi session is the running PID X serving?"

The CLI does not embed the session id in ``argv`` for fresh (non-resumed)
sessions, and the OS process title can be truncated, so a side-channel file
that records the explicit ``(pid, session_id, work_dir, ...)`` tuple is the
most reliable cross-platform signal.

Two locations are written, with identical contents:

1. ``<session_dir>/runtime.json`` — discoverable when you know the session.
2. ``<share_dir>/runtime/<pid>.json`` — discoverable when you know **only**
   the PID, with O(1) lookup. This is what an external observer that sees
   PID X in Task Manager / Windows Terminal needs in order to map back to a
   session id without scanning every session directory on disk.

Both files are written atomically via ``atomic_json_write`` and contain the
same small, stable schema. External consumers should treat unknown fields
as forward-compatible additions.
"""

from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import cast

from kimi_cli.share import get_share_dir
from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

RUNTIME_STATUS_FILENAME = "runtime.json"
RUNTIME_STATUS_SCHEMA_VERSION = 1
RUNTIME_PID_INDEX_DIR_NAME = "runtime"


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


def _pid_index_dir() -> Path:
    """Return the well-known directory for PID-keyed runtime sidecars."""
    return get_share_dir() / RUNTIME_PID_INDEX_DIR_NAME


def _pid_index_path(pid: int) -> Path:
    return _pid_index_dir() / f"{pid}.json"


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
    """Atomically write the runtime status sidecars for this session.

    Writes two files with identical contents: ``<session_dir>/runtime.json``
    (so a session-aware caller can find it) and
    ``<share_dir>/runtime/<pid>.json`` (so a PID-only consumer can look it
    up in O(1) without scanning the sessions tree). Both go through the
    repo's ``atomic_json_write`` helper, so an external observer never sees
    a partially written file: it sees either the previous contents or the
    fully committed new contents.

    Returns the path of the per-session file that was written; the
    PID-keyed mirror lives at :func:`_pid_index_path` for the same PID.

    Exceptions from the underlying I/O (``OSError``, ``PermissionError``,
    read-only filesystem, etc.) are propagated to the caller; this function
    does not log or swallow them. Callers that want best-effort semantics
    should wrap the call in ``contextlib.suppress(OSError)``. On failure no
    leftover ``.tmp`` file is kept on disk. The PID-keyed mirror is written
    after the per-session file; if the per-session write succeeded but the
    mirror write fails, the mirror failure is also raised so the caller can
    decide how to react.
    """
    resolved_pid = pid if pid is not None else os.getpid()
    status = RuntimeStatus(
        schema_version=RUNTIME_STATUS_SCHEMA_VERSION,
        pid=resolved_pid,
        session_id=session_id,
        work_dir=work_dir,
        hostname=socket.gethostname(),
        started_at=time.time(),
        kimi_version=_safe_kimi_version(),
    )
    payload = asdict(status)
    target = _runtime_status_path(session_dir)
    atomic_json_write(payload, target)

    pid_index_target = _pid_index_path(resolved_pid)
    pid_index_target.parent.mkdir(parents=True, exist_ok=True)
    atomic_json_write(payload, pid_index_target)

    return target


def clear_runtime_status(session_dir: Path, *, pid: int | None = None) -> None:
    """Remove the runtime status sidecars for this session, if present.

    Removes both the per-session file and the PID-keyed mirror so external
    observers stop mapping the PID to a now-dead session. When ``pid`` is
    not provided, the current contents of the per-session file are read to
    discover which PID's mirror to delete; if that read fails for any
    reason, only the per-session file is removed and the mirror is left
    for the next ``prune_stale_pid_index`` sweep to clean up.

    Safe to call multiple times and on directories that no longer exist.
    """
    target = _runtime_status_path(session_dir)
    target_pid = pid
    if target_pid is None:
        existing = read_runtime_status(session_dir)
        if existing is not None:
            target_pid = existing.pid
    try:
        target.unlink(missing_ok=True)
    except OSError:
        logger.debug("Failed to remove runtime status file {file}", file=target)
    if target_pid is not None:
        mirror = _pid_index_path(target_pid)
        try:
            mirror.unlink(missing_ok=True)
        except OSError:
            logger.debug("Failed to remove PID index file {file}", file=mirror)


def _parse_runtime_payload(raw: str, source: Path) -> RuntimeStatus | None:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.debug("Malformed runtime status file {file}", file=source)
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
        logger.debug("Incomplete runtime status file {file}", file=source)
        return None


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
    return _parse_runtime_payload(raw, target)


def find_runtime_status_by_pid(pid: int) -> RuntimeStatus | None:
    """Look up a live session by PID via the ``<share_dir>/runtime/<pid>.json`` mirror.

    This is the entry point for external observers that have only a PID
    (for example a launcher PID seen in Task Manager / Windows Terminal)
    and need to recover the session id without scanning every session
    directory. Returns ``None`` if no mirror exists, the mirror is stale or
    malformed, or the schema version is unrecognised. The launcher case
    where the PID-keyed mirror does not directly match (e.g. ``kimi.exe``
    shim spawns a Python child whose PID is the one recorded) is handled
    by the caller — typically by walking process descendants and trying
    each candidate PID.
    """
    target = _pid_index_path(pid)
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        logger.debug("Failed to read PID index file {file}", file=target)
        return None
    return _parse_runtime_payload(raw, target)
