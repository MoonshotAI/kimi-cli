"""Runtime status file for an active interactive Kimi session.

This module writes a small JSON file at ``<session_dir>/runtime.json`` while
an interactive Kimi session is alive. It exists so that **external** tools
(terminal multiplexers, tab managers, IDE integrations, observability
daemons) can answer the question:

    "Which Kimi session is the running PID X serving?"

The CLI does not embed the session id in ``argv`` for fresh (non-resumed)
sessions, and the OS process title can be truncated, so a side-channel
file that records the explicit ``(pid, session_id, work_dir, ...)`` tuple
is the most reliable cross-platform signal.

Lifecycle:

* Written on session start (clean launch or ``--resume``); the resume case
  atomically overwrites whatever the previous PID wrote.
* Never deleted by kimi-cli — neither on clean ``/quit`` nor on crash. From
  an external observer's standpoint a clean quit and a force-kill are
  indistinguishable on disk: in both cases the recorded PID no longer
  exists. Consumers that need certainty should always verify the PID is
  alive before treating a record as live.
* The file is removed only when the surrounding session directory itself
  is deleted via ``/delete`` (or manual cleanup), which gives a natural
  bound on accumulation.

The file is written atomically via :func:`atomic_json_write` and contains
a small, stable schema. External consumers should treat unknown fields as
forward-compatible additions.
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
    filesystem, etc.) propagate to the caller; this function does not log
    or swallow them. Callers that want best-effort semantics should wrap
    the call in ``contextlib.suppress(OSError)``. On failure no leftover
    ``.tmp`` file is kept on disk.
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


def read_runtime_status(session_dir: Path) -> RuntimeStatus | None:
    """Read the runtime status file from a session directory, if present.

    Returns ``None`` if the file is missing, malformed, or written by a
    schema version this code does not understand. "Malformed" includes
    truncated UTF-8, syntactically invalid JSON, a non-object payload,
    and any field whose JSON type does not match the dataclass — the
    function never coerces ``None`` / list / dict into a string just to
    satisfy the constructor.

    Note: a returned record only proves that *some* Kimi process once
    claimed this session. The PID may already be dead (clean quit or
    crash). Consumers must verify liveness themselves before treating
    the record as a currently-running session.
    """
    target = _runtime_status_path(session_dir)
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError):
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

    schema_version = parsed.get("schema_version")
    pid = parsed.get("pid")
    session_id = parsed.get("session_id")
    work_dir = parsed.get("work_dir")
    hostname = parsed.get("hostname")
    started_at = parsed.get("started_at")
    kimi_version = parsed.get("kimi_version")

    if not isinstance(schema_version, int):
        return None
    if not isinstance(pid, int):
        return None
    if not isinstance(session_id, str):
        return None
    if not isinstance(work_dir, str):
        return None
    if not isinstance(hostname, str):
        return None
    if not isinstance(started_at, (int, float)) or isinstance(started_at, bool):
        return None
    if kimi_version is not None and not isinstance(kimi_version, str):
        return None

    return RuntimeStatus(
        schema_version=schema_version,
        pid=pid,
        session_id=session_id,
        work_dir=work_dir,
        hostname=hostname,
        started_at=float(started_at),
        kimi_version=kimi_version,
    )
