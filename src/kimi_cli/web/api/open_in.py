"""Open local apps for a path on the host machine."""

from __future__ import annotations

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

    app: Literal["finder", "cursor", "vscode", "iterm", "terminal", "antigravity"]
    path: str


class OpenInResponse(BaseModel):
    """Open path response."""

    ok: bool
    detail: str | None = None


def _resolve_path(path: str) -> Path:
    """Resolve and validate a path (file or directory)."""
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
    script = f'tell application "Terminal" to do script "cd " & quoted form of "{path}"'
    _run_command(["osascript", "-e", script])


def _open_iterm(path: Path) -> None:
    script = "\n".join(
        [
            'tell application "iTerm"',
            "  create window with default profile",
            "  tell current session of current window",
            f'    write text "cd " & quoted form of "{path}"',
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

    path = _resolve_path(request.path)
    is_file = path.is_file()

    try:
        match request.app:
            case "finder":
                if is_file:
                    # Reveal file in Finder
                    _run_command(["open", "-R", str(path)])
                else:
                    _run_command(["open", str(path)])
            case "cursor":
                _open_app("Cursor", path)
            case "vscode":
                _open_app("Visual Studio Code", path, fallback="Code")
            case "antigravity":
                _open_app("Antigravity", path)
            case "iterm":
                # Terminal apps need directory
                directory = path.parent if is_file else path
                _open_iterm(directory)
            case "terminal":
                directory = path.parent if is_file else path
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
