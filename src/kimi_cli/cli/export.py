"""Export command for packaging session data."""

from __future__ import annotations

import asyncio
import io
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

    # Collect files
    files = sorted(f for f in session_dir.iterdir() if f.is_file())
    if not files:
        typer.echo(f"Error: session '{session_id}' has no files.", err=True)
        raise typer.Exit(code=1)

    # Determine output path
    if output is None:
        output = Path.cwd() / f"session-{session_id}.zip"

    # Create ZIP
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in files:
            zf.write(file_path, arcname=file_path.name)
    buf.seek(0)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(buf.getvalue())

    typer.echo(str(output))
