"""Sessions API routes."""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, Response
from kaos.path import KaosPath
from loguru import logger
from pydantic import BaseModel
from starlette.websockets import WebSocket, WebSocketDisconnect

from kimi_cli.metadata import load_metadata, save_metadata
from kimi_cli.session import Session as KimiCLISession
from kimi_cli.web.models import Session, SessionStatus
from kimi_cli.web.runner.messages import send_history_complete
from kimi_cli.web.runner.process import KimiCLIRunner
from kimi_cli.web.store.sessions import (
    JointSession,
    invalidate_sessions_cache,
    load_all_sessions_cached,
    load_session_by_id,
)
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCInMessageAdapter,
    JSONRPCPromptMessage,
)
from kimi_cli.wire.serde import deserialize_wire_message
from kimi_cli.wire.types import is_request

router = APIRouter(prefix="/api/sessions", tags=["sessions"])
work_dirs_router = APIRouter(prefix="/api/work-dirs", tags=["work-dirs"])

# Constants
MAX_UPLOAD_SIZE = 100 * 1024 * 1024  # 100MB


def sanitize_filename(filename: str) -> str:
    """Remove potentially dangerous characters from filename."""
    # Keep only alphanumeric, dots, underscores, hyphens, and spaces
    safe = "".join(c for c in filename if c.isalnum() or c in "._- ")
    return safe.strip() or "unnamed"


def get_runner(req: Request) -> KimiCLIRunner:
    """Get the KimiCLIRunner from the FastAPI app state."""
    return req.app.state.runner


def get_runner_ws(ws: WebSocket) -> KimiCLIRunner:
    """Get the KimiCLIRunner from the FastAPI app state (for WebSocket routes)."""
    return ws.app.state.runner


def get_editable_session(
    session_id: UUID,
    runner: KimiCLIRunner,
) -> JointSession:
    """Get a session and verify it's not busy."""
    session = load_session_by_id(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    # Check if session is busy
    session_process = runner.get_session(session_id)
    if session_process and session_process.is_busy:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Session is busy. Please wait for it to complete before modifying.",
        )
    return session


async def replay_history(ws: WebSocket, session_dir: Path) -> None:
    """Replay historical wire messages from wire.jsonl to a WebSocket."""
    wire_file = session_dir / "wire.jsonl"
    if not wire_file.exists():
        return

    try:
        with open(wire_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        continue
                    record = cast(dict[str, Any], record)
                    record_type = record.get("type")
                    if isinstance(record_type, str) and record_type == "metadata":
                        continue
                    message_raw = record.get("message")
                    if not isinstance(message_raw, dict):
                        continue
                    message_raw = cast(dict[str, Any], message_raw)
                    message = deserialize_wire_message(message_raw)
                    # Convert to JSONRPC event format
                    event_msg: dict[str, Any] = {
                        "jsonrpc": "2.0",
                        "method": "request" if is_request(message) else "event",
                        "params": message_raw,
                    }
                    await ws.send_text(json.dumps(event_msg, ensure_ascii=False))
                except (json.JSONDecodeError, KeyError, ValueError, TypeError):
                    continue
    except Exception:
        pass


@router.get("/", summary="List all sessions")
async def list_sessions(runner: KimiCLIRunner = Depends(get_runner)) -> list[Session]:
    """List all sessions."""
    sessions = load_all_sessions_cached()
    for session in sessions:
        session_process = runner.get_session(session.session_id)
        session.is_running = session_process is not None and session_process.is_running
        session.status = session_process.status if session_process else None
    return cast(list[Session], sessions)


@router.get("/{session_id}", summary="Get session")
async def get_session(
    session_id: UUID,
    runner: KimiCLIRunner = Depends(get_runner),
) -> Session | None:
    """Get a session by ID."""
    session = load_session_by_id(session_id)
    if session is not None:
        session_process = runner.get_session(session_id)
        session.is_running = session_process is not None and session_process.is_running
        session.status = session_process.status if session_process else None
    return session


@router.post("/", summary="Create a new session")
async def create_session(request: CreateSessionRequest | None = None) -> Session:
    """Create a new session."""
    # Use provided work_dir or default to user's home directory
    if request and request.work_dir:
        work_dir_path = Path(request.work_dir)
        # Validate the directory exists
        if not work_dir_path.exists():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Directory does not exist: {request.work_dir}",
            )
        if not work_dir_path.is_dir():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Path is not a directory: {request.work_dir}",
            )
        work_dir = KaosPath.unsafe_from_local_path(work_dir_path)
    else:
        work_dir = KaosPath.unsafe_from_local_path(Path.home())
    kimi_cli_session = await KimiCLISession.create(work_dir=work_dir)
    context_file = kimi_cli_session.dir / "context.jsonl"
    invalidate_sessions_cache()
    return Session(
        session_id=UUID(kimi_cli_session.id),
        title=kimi_cli_session.title,
        last_updated=datetime.fromtimestamp(context_file.stat().st_mtime, tz=UTC),
        is_running=False,
        status=SessionStatus(
            session_id=UUID(kimi_cli_session.id),
            state="stopped",
            seq=0,
            worker_id=None,
            reason=None,
            detail=None,
            updated_at=datetime.now(UTC),
        ),
        work_dir=str(work_dir),
        session_dir=str(kimi_cli_session.dir),
    )


class CreateSessionRequest(BaseModel):
    """Create session request."""

    work_dir: str | None = None


class UploadSessionFileResponse(BaseModel):
    """Upload file response."""

    path: str
    filename: str
    size: int


@router.post("/{session_id}/files", summary="Upload file to session")
async def upload_session_file(
    session_id: UUID,
    file: UploadFile,
    runner: KimiCLIRunner = Depends(get_runner),
) -> UploadSessionFileResponse:
    """Upload a file to a session."""
    session = get_editable_session(session_id, runner)
    session_dir = session.kimi_cli_session.dir
    upload_dir = session_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Read and validate file size
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {MAX_UPLOAD_SIZE // 1024 // 1024}MB)",
        )

    # Generate safe filename
    file_name = str(uuid4())
    if file.filename:
        safe_name = sanitize_filename(file.filename)
        name, ext = os.path.splitext(safe_name)
        file_name = f"{name}_{file_name[:6]}{ext}"

    upload_path = upload_dir / file_name
    upload_path.write_bytes(content)

    return UploadSessionFileResponse(
        path=str(upload_path),
        filename=file_name,
        size=len(content),
    )


@router.get(
    "/{session_id}/uploads/{path:path}",
    summary="Get uploaded file from session uploads",
)
async def get_session_upload_file(
    session_id: UUID,
    path: str,
) -> Response:
    """Get a file from a session's uploads directory."""
    session = load_session_by_id(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )

    uploads_dir = (session.kimi_cli_session.dir / "uploads").resolve()
    if not uploads_dir.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Uploads directory not found",
        )

    file_path = (uploads_dir / path).resolve()
    if not file_path.is_relative_to(uploads_dir):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid path: path traversal not allowed",
        )

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    media_type, _ = mimetypes.guess_type(file_path.name)
    encoded_filename = quote(file_path.name, safe="")
    return FileResponse(
        file_path,
        media_type=media_type or "application/octet-stream",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}",
        },
    )


@router.get(
    "/{session_id}/files/{path:path}",
    summary="Get file or list directory from session work_dir",
)
async def get_session_file(
    session_id: UUID,
    path: str,
) -> Response:
    """Get a file or list directory from session work directory."""
    session = load_session_by_id(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )

    # Security check: prevent path traversal attacks using resolve()
    work_dir = Path(str(session.kimi_cli_session.work_dir)).resolve()
    file_path = (work_dir / path).resolve()
    if not file_path.is_relative_to(work_dir):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid path: path traversal not allowed",
        )

    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    if file_path.is_dir():
        result: list[dict[str, str | int]] = []
        for subpath in file_path.iterdir():
            if subpath.is_dir():
                result.append({"name": subpath.name, "type": "directory"})
            else:
                result.append(
                    {
                        "name": subpath.name,
                        "type": "file",
                        "size": subpath.stat().st_size,
                    }
                )
        result.sort(key=lambda x: (cast(str, x["type"]), cast(str, x["name"])))
        return Response(content=json.dumps(result), media_type="application/json")

    content = file_path.read_bytes()
    media_type, _ = mimetypes.guess_type(file_path.name)
    encoded_filename = quote(file_path.name, safe="")
    return Response(
        content=content,
        media_type=media_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"},
    )


@router.delete("/{session_id}", summary="Delete a session")
async def delete_session(session_id: UUID, runner: KimiCLIRunner = Depends(get_runner)) -> None:
    """Delete a session."""
    session = get_editable_session(session_id, runner)
    session_process = runner.get_session(session_id)
    if session_process is not None:
        await session_process.stop()
    wd_meta = session.kimi_cli_session.work_dir_meta
    if wd_meta.last_session_id == str(session_id):
        metadata = load_metadata()
        for wd in metadata.work_dirs:
            if wd.path == wd_meta.path:
                wd.last_session_id = None
                break
        save_metadata(metadata)
    session_dir = session.kimi_cli_session.dir
    if session_dir.exists():
        shutil.rmtree(session_dir)
    invalidate_sessions_cache()


@router.websocket("/{session_id}/stream")
async def session_stream(
    session_id: UUID,
    websocket: WebSocket,
    runner: KimiCLIRunner = Depends(get_runner_ws),
) -> None:
    """WebSocket stream for a session.

    Flow:
    1. Accept the WebSocket connection
    2. If history exists, attach WebSocket in replay mode
    3. Replay history messages from wire.jsonl
    4. Start worker if needed
    5. Flush buffered live messages and send status snapshot
    6. Forward incoming messages to the subprocess
    7. Clean up on disconnect
    """
    await websocket.accept()

    # Check if session exists
    session = load_session_by_id(session_id)
    if session is None:
        await websocket.close(code=4004, reason="Session not found")
        return

    # Check if session has history
    session_dir = session.kimi_cli_session.dir
    wire_file = session_dir / "wire.jsonl"
    has_history = wire_file.exists()

    session_process = None
    attached = False
    try:
        if has_history:
            # Attach WebSocket in replay mode before history replay
            session_process = await runner.get_or_create_session(session_id)
            await session_process.add_websocket_and_begin_replay(websocket)
            attached = True

            # Replay history
            try:
                await replay_history(websocket, session_dir)
            except Exception as e:
                logger.warning(f"Failed to replay history: {e}")

        await send_history_complete(websocket)

        # Ensure work_dir exists
        work_dir = Path(str(session.kimi_cli_session.work_dir))
        work_dir.mkdir(parents=True, exist_ok=True)

        if not attached:
            # No history: attach and start worker
            session_process = await runner.get_or_create_session(session_id)
            await session_process.add_websocket_and_begin_replay(websocket)
            attached = True

        assert session_process is not None
        # End replay and start worker
        await session_process.end_replay(websocket)
        await session_process.start()
        await session_process.send_status_snapshot(websocket)

        # Forward incoming messages to the subprocess
        while True:
            try:
                message = await websocket.receive_text()
                # Reject new prompts when session is busy
                if session_process.is_busy:
                    try:
                        in_message = JSONRPCInMessageAdapter.validate_json(message)
                    except ValueError:
                        in_message = None
                    if isinstance(in_message, JSONRPCPromptMessage):
                        await websocket.send_text(
                            JSONRPCErrorResponse(
                                id=in_message.id,
                                error=JSONRPCErrorObject(
                                    code=ErrorCodes.INVALID_STATE,
                                    message=(
                                        "Session is busy; wait for completion before sending "
                                        "a new prompt."
                                    ),
                                ),
                            ).model_dump_json()
                        )
                        continue

                logger.debug(f"sending message to session {session_id}")
                await session_process.send_message(message)
            except WebSocketDisconnect:
                logger.debug("WebSocket disconnected")
                break
            except Exception as e:
                logger.warning(f"WebSocket error: {e.__class__.__name__} {e}")
                break
    finally:
        if attached and session_process:
            await session_process.remove_websocket(websocket)


@work_dirs_router.get("/", summary="List available work directories")
async def get_work_dirs() -> list[str]:
    """Get a list of available work directories from metadata."""
    metadata = load_metadata()
    work_dirs: list[str] = []
    for wd in metadata.work_dirs:
        # Filter out temporary directories
        if "/tmp" in wd.path or "/var/folders" in wd.path or "/.cache/" in wd.path:
            continue
        # Verify directory exists
        if Path(wd.path).exists():
            work_dirs.append(wd.path)
    # Return at most 20 directories
    return work_dirs[:20]


@work_dirs_router.get("/startup", summary="Get the startup directory")
async def get_startup_dir(request: Request) -> str:
    """Get the directory where kimi web was started."""
    return request.app.state.startup_dir
