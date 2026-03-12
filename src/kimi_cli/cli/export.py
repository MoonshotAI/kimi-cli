"""Export command for packaging session data."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Annotated

import typer

cli = typer.Typer(help="Export session data.")


def _find_session_by_id(session_id: str) -> Path | None:
    """Find a session directory by session ID across all work directories."""
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


@cli.callback(invoke_without_command=True)
def export(
    session_id: Annotated[
        str,
        typer.Argument(help="Session ID to export."),
    ],
    output: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help="Output ZIP file path. Default: session-{id}.zip in current directory.",
        ),
    ] = None,
) -> None:
    """Export a session as a ZIP archive."""
    session_dir = _find_session_by_id(session_id)
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
