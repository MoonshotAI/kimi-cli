"""Export command for packaging session data."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import platform
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer
from kaos.path import KaosPath

from kimi_cli.wire.file import WireFileMetadata, parse_wire_file_line
from kimi_cli.wire.types import TurnBegin

if TYPE_CHECKING:
    from kimi_cli.session import Session

# Include global log files whose last modification is within this window.
_LOG_RETENTION_SECONDS = 2 * 24 * 60 * 60  # 2 days
# Maximum total size of log files to bundle in an export archive.
_MAX_LOG_BYTES = 100 * 1024 * 1024  # 100 MB

cli = typer.Typer(help="Export session data.")


async def _find_session_in_work_dir(work_dir: KaosPath, session_id: str) -> Session | None:
    from kimi_cli.session import Session

    return await Session.find(work_dir, session_id)


async def _load_previous_session(work_dir: KaosPath) -> Session | None:
    from kimi_cli.session import Session

    return await Session.continue_(work_dir)


def _resolve_work_dir(ctx: typer.Context) -> KaosPath:
    root_ctx = ctx.find_root()
    local_work_dir = root_ctx.params.get("local_work_dir")
    if local_work_dir is None:
        return KaosPath.cwd()
    return KaosPath.unsafe_from_local_path(local_work_dir)


def _find_session_by_id(session_id: str, *, work_dir: KaosPath | None = None) -> Path | None:
    """Find a session directory by ID, preferring the current work directory."""
    if work_dir is not None:
        session = asyncio.run(_find_session_in_work_dir(work_dir, session_id))
        if session is not None:
            return session.dir

    from kimi_cli.share import get_share_dir

    sessions_root = get_share_dir() / "sessions"
    if not sessions_root.exists():
        return None

    for work_dir_hash_dir in sessions_root.iterdir():
        if not work_dir_hash_dir.is_dir():
            continue
        candidate = work_dir_hash_dir / session_id
        if candidate.is_dir():
            return candidate

    return None


def _last_user_message_timestamp(session_dir: Path) -> float | None:
    wire_file = session_dir / "wire.jsonl"
    if not wire_file.exists():
        return None

    last_turn_begin: float | None = None
    try:
        with wire_file.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = parse_wire_file_line(line)
                except Exception:
                    continue
                if isinstance(parsed, WireFileMetadata):
                    continue
                if isinstance(parsed.to_wire_message(), TurnBegin):
                    last_turn_begin = parsed.timestamp
    except OSError:
        return None

    return last_turn_begin


def _session_time_range(session_dir: Path) -> tuple[float | None, float | None]:
    """Return (first_timestamp, last_timestamp) from wire.jsonl."""
    wire_file = session_dir / "wire.jsonl"
    if not wire_file.exists():
        return None, None

    first_ts: float | None = None
    last_ts: float | None = None
    try:
        with wire_file.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = parse_wire_file_line(line)
                except Exception:
                    continue
                if isinstance(parsed, WireFileMetadata):
                    continue
                if first_ts is None:
                    first_ts = parsed.timestamp
                last_ts = parsed.timestamp
    except OSError:
        pass
    return first_ts, last_ts


def _collect_recent_log_files(session_dir: Path) -> list[Path]:
    """Collect global log files relevant to a session export.

    Includes the union of:
    1. Files near the session's active period (wire.jsonl timestamps ± 2 days)
    2. Files near the export time (now ± 2 days)
    """
    from kimi_cli.share import get_share_dir

    log_dir = get_share_dir() / "logs"
    if not log_dir.is_dir():
        return []

    now = time.time()
    export_cutoff = now - _LOG_RETENTION_SECONDS

    session_start, session_end = _session_time_range(session_dir)
    session_cutoff: float | None = None
    session_upper: float | None = None
    if session_start is not None:
        session_cutoff = session_start - _LOG_RETENTION_SECONDS
        session_upper = (session_end or session_start) + _LOG_RETENTION_SECONDS

    # Collect candidates with (mtime, size, path)
    candidates: list[tuple[float, int, Path]] = []
    for f in log_dir.iterdir():
        if not f.is_file() or not f.name.startswith("kimi.") or not f.name.endswith(".log"):
            continue
        try:
            st = f.stat()
            mtime = st.st_mtime
            size = st.st_size
        except OSError:
            continue

        # Group 2: near export time
        if mtime >= export_cutoff:
            candidates.append((mtime, size, f))
            continue

        # Group 1: near session active period
        if (
            session_cutoff is not None
            and session_upper is not None
            and mtime >= session_cutoff
            and mtime <= session_upper
        ):
            candidates.append((mtime, size, f))

    # Prioritize files closest to session_end (most diagnostic value),
    # falling back to recency when session time is unavailable.
    anchor = session_end or session_start or now
    candidates.sort(key=lambda item: abs(item[0] - anchor))

    # Apply size cap — keep highest-priority files first
    result: list[tuple[float, Path]] = []
    total_size = 0
    for mtime, size, path in candidates:
        if total_size + size > _MAX_LOG_BYTES:
            break
        result.append((mtime, path))
        total_size += size

    result.sort(key=lambda item: item[0])
    return [path for _, path in result]


def _build_manifest(session_id: str, session_dir: Path) -> dict[str, str | None]:
    """Build a manifest dict with system and session diagnostics.

    Best-effort: never raises — returns a minimal manifest on failure.
    """
    manifest: dict[str, str | None] = {"session_id": session_id}
    try:
        from kimi_cli.constant import get_version

        manifest["exported_at"] = datetime.now(UTC).isoformat()
        manifest["kimi_cli_version"] = get_version()
        manifest["python_version"] = platform.python_version()
        manifest["os"] = f"{platform.system()} {platform.release()}"
        manifest["platform"] = platform.machine()

        first_ts, last_ts = _session_time_range(session_dir)
        if first_ts is not None:
            manifest["session_first_activity"] = datetime.fromtimestamp(first_ts, UTC).isoformat()
        if last_ts is not None:
            manifest["session_last_activity"] = datetime.fromtimestamp(last_ts, UTC).isoformat()
    except Exception:
        pass
    return manifest


def _format_message_timestamp(timestamp: float | None) -> str:
    if timestamp is None:
        return "(no user message)"
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _confirm_previous_session(session: Session) -> bool:
    last_user_message = _format_message_timestamp(_last_user_message_timestamp(session.dir))

    typer.echo("About to export the previous session for this working directory:")
    typer.echo()
    typer.echo(f"Work dir: {session.work_dir}")
    typer.echo(f"Session ID: {session.id}")
    typer.echo(f"Title: {session.title}")
    typer.echo(f"Last user message: {last_user_message}")
    typer.echo()
    return typer.confirm("Export this session?", default=False)


@cli.command(name="export")
def export(
    ctx: typer.Context,
    session_id: Annotated[
        str | None,
        typer.Argument(help="Session ID to export. Defaults to the previous session."),
    ] = None,
    output: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help="Output ZIP file path. Default: session-{id}.zip in current directory.",
        ),
    ] = None,
    yes: Annotated[
        bool,
        typer.Option(
            "--yes",
            "-y",
            help="Skip confirmation when exporting the previous session by default.",
        ),
    ] = False,
) -> None:
    """Export a session as a ZIP archive."""
    work_dir = _resolve_work_dir(ctx)

    if session_id is None:
        session = asyncio.run(_load_previous_session(work_dir))
        if session is None:
            typer.echo("Error: no previous session found for the working directory.", err=True)
            raise typer.Exit(code=1)
        if not yes and not _confirm_previous_session(session):
            typer.echo("Export cancelled.")
            return
        session_id = session.id
        session_dir = session.dir
    else:
        session_dir = _find_session_by_id(session_id, work_dir=work_dir)
        if session_dir is None:
            typer.echo(f"Error: session '{session_id}' not found.", err=True)
            raise typer.Exit(code=1)

    # Collect all files in the session directory (including subagents/ and tasks/)
    files = sorted(f for f in session_dir.rglob("*") if f.is_file())
    if not files:
        typer.echo(f"Error: session '{session_id}' has no files.", err=True)
        raise typer.Exit(code=1)

    # Determine output path
    if output is None:
        output = Path.cwd() / f"session-{session_id}.zip"

    # Collect recent global log files for diagnostics
    log_files = _collect_recent_log_files(session_dir)

    # Build manifest with system diagnostics
    manifest = _build_manifest(session_id, session_dir)

    # Create ZIP
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for file_path in files:
            with contextlib.suppress(OSError):
                zf.write(file_path, arcname=str(file_path.relative_to(session_dir)))
        for log_path in log_files:
            with contextlib.suppress(OSError):
                zf.write(log_path, arcname=f"logs/{log_path.name}")
    buf.seek(0)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(buf.getvalue())

    typer.echo(str(output))
    if log_files:
        typer.echo(
            "\nNote: This archive includes recent diagnostic logs that may contain "
            "file paths, commands, or configuration from other sessions. "
            "Please review the contents before sharing.",
            err=True,
        )
