"""Open local apps for a path on the host machine."""

from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from loguru import logger
from pydantic import BaseModel

router = APIRouter(prefix="/api/open-in", tags=["open-in"])


class OpenInRequest(BaseModel):
    """Open path in a local app."""

    app: Literal["finder", "cursor", "vscode", "iterm", "terminal"]
    path: str


class OpenInResponse(BaseModel):
    """Open path response."""

    ok: bool
    detail: str | None = None


def _resolve_directory(path: str) -> Path:
    resolved = Path(path).expanduser()
    try:
        resolved = resolved.resolve()
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path does not exist: {path}",
        ) from None

    if not resolved.exists():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path does not exist: {path}",
        )
    if not resolved.is_dir():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path is not a directory: {path}",
        )
    return resolved


def _run_command(args: list[str]) -> None:
    subprocess.run(
        args,
        check=True,
        capture_output=True,
        text=True,
    )


def _open_app(app_name: str, path: Path, fallback: str | None = None) -> None:
    try:
        _run_command(["open", "-a", app_name, str(path)])
        return
    except subprocess.CalledProcessError as exc:
        if fallback is None:
            raise
        logger.warning("Open with {} failed: {}", app_name, exc)
    _run_command(["open", "-a", fallback, str(path)])


def _open_terminal(path: Path) -> None:
    command = f"cd {shlex.quote(str(path))}"
    script = f'tell application "Terminal" to do script "{command}"'
    _run_command(["osascript", "-e", script])


def _open_iterm(path: Path) -> None:
    command = f"cd {shlex.quote(str(path))}"
    script = "\n".join(
        [
            'tell application "iTerm"',
            "  create window with default profile",
            "  tell current session of current window",
            f'    write text "{command}"',
            "  end tell",
            "end tell",
        ]
    )
    try:
        _run_command(["osascript", "-e", script])
    except subprocess.CalledProcessError:
        script = script.replace('"iTerm"', '"iTerm2"')
        _run_command(["osascript", "-e", script])


@router.post("", summary="Open a path in a local application")
async def open_in(request: OpenInRequest) -> OpenInResponse:
    if sys.platform != "darwin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Open-in is only supported on macOS.",
        )

    directory = _resolve_directory(request.path)

    try:
        match request.app:
            case "finder":
                _run_command(["open", str(directory)])
            case "cursor":
                _open_app("Cursor", directory)
            case "vscode":
                _open_app("Visual Studio Code", directory, fallback="Code")
            case "iterm":
                _open_iterm(directory)
            case "terminal":
                _open_terminal(directory)
            case _:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unsupported app: {request.app}",
                )
    except subprocess.CalledProcessError as exc:
        logger.warning("Open-in failed ({}): {}", request.app, exc)
        detail = exc.stderr.strip() if exc.stderr else "Failed to open application."
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=detail,
        ) from exc

    return OpenInResponse(ok=True)
