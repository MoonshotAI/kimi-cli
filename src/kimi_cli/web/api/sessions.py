"""Sessions API routes."""

from __future__ import annotations

import asyncio
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
from kimi_cli.web.auth import is_origin_allowed, is_private_ip, verify_token
from kimi_cli.web.models import (
    GenerateTitleRequest,
    GenerateTitleResponse,
    GitDiffStats,
    GitFileDiff,
    Session,
    SessionStatus,
    UpdateSessionRequest,
)
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
DEFAULT_MAX_PUBLIC_PATH_DEPTH = 6
SENSITIVE_PATH_PARTS = {
    "id_rsa",
    "id_ed25519",
    "known_hosts",
    "credentials",
    ".aws",
    ".ssh",
    ".gnupg",
    ".kube",
    ".npmrc",
    ".pypirc",
    ".netrc",
}
SENSITIVE_PATH_EXTENSIONS = {
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".kdbx",
    ".der",
}
# Home directory patterns to detect if resolved path escapes to sensitive locations
SENSITIVE_HOME_PATHS = {
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
}


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


def _relative_parts(path: Path) -> list[str]:
    return [part for part in path.parts if part not in {"", "."}]


def _is_sensitive_relative_path(rel_path: Path) -> bool:
    parts = _relative_parts(rel_path)
    for part in parts:
        if part.startswith("."):
            return True
        if part.lower() in SENSITIVE_PATH_PARTS:
            return True
    return rel_path.suffix.lower() in SENSITIVE_PATH_EXTENSIONS


def _contains_symlink(path: Path, base: Path) -> bool:
    """Check if any component of the path (relative to base) is a symlink."""
    try:
        current = base
        rel_parts = path.relative_to(base).parts
        for part in rel_parts:
            current = current / part
            if current.is_symlink():
                return True
    except (ValueError, OSError):
        return True
    return False


def _is_path_in_sensitive_location(path: Path) -> bool:
    """Check if resolved path points to a sensitive location (e.g., ~/.ssh, ~/.aws)."""
    try:
        home = Path.home()
        if path.is_relative_to(home):
            rel_to_home = path.relative_to(home)
            first_part = rel_to_home.parts[0] if rel_to_home.parts else ""
            if first_part in SENSITIVE_HOME_PATHS:
                return True
    except (ValueError, RuntimeError):
        pass
    return False


def _ensure_public_file_access_allowed(
    rel_path: Path,
    restrict_sensitive_apis: bool,
    max_path_depth: int = DEFAULT_MAX_PUBLIC_PATH_DEPTH,
) -> None:
    if not restrict_sensitive_apis:
        return
    rel_parts = _relative_parts(rel_path)
    if len(rel_parts) > max_path_depth:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Path too deep for public access "
            f"(max depth: {max_path_depth}, current: {len(rel_parts)}).",
        )
    if _is_sensitive_relative_path(rel_path):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access to sensitive files is disabled.",
        )


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
    request: Request,
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
    requested_path = work_dir / path
    file_path = requested_path.resolve()

    # Check path traversal
    if not file_path.is_relative_to(work_dir):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid path: path traversal not allowed",
        )

    rel_path = file_path.relative_to(work_dir)
    restrict_sensitive_apis = getattr(request.app.state, "restrict_sensitive_apis", False)
    max_path_depth = (
        getattr(request.app.state, "max_public_path_depth", None) or DEFAULT_MAX_PUBLIC_PATH_DEPTH
    )

    # Additional security checks when restricting sensitive APIs
    if restrict_sensitive_apis:
        # Check for symlinks in the path
        if _contains_symlink(requested_path, work_dir):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Symbolic links are not allowed in public mode.",
            )

        # Check if resolved path points to sensitive location
        if _is_path_in_sensitive_location(file_path):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access to sensitive system directories is not allowed.",
            )

    _ensure_public_file_access_allowed(rel_path, restrict_sensitive_apis, max_path_depth)

    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    if file_path.is_dir():
        result: list[dict[str, str | int]] = []
        for subpath in file_path.iterdir():
            if restrict_sensitive_apis:
                rel_subpath = rel_path / subpath.name
                if _is_sensitive_relative_path(rel_subpath):
                    continue
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


@router.patch("/{session_id}", summary="Update session")
async def update_session(
    session_id: UUID,
    request: UpdateSessionRequest,
    runner: KimiCLIRunner = Depends(get_runner),
) -> Session:
    """Update a session (e.g., rename title)."""
    session = get_editable_session(session_id, runner)
    session_dir = session.kimi_cli_session.dir

    # Read or create metadata.json
    metadata_file = session_dir / "metadata.json"
    metadata_data = {}
    if metadata_file.exists():
        try:
            metadata_data = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            metadata_data = {}

    # Update title if provided
    if request.title is not None:
        metadata_data["title"] = request.title

    # Write metadata.json
    metadata_json = json.dumps(metadata_data, ensure_ascii=False, indent=2)
    metadata_file.write_text(metadata_json, encoding="utf-8")

    # Invalidate cache to force reload
    invalidate_sessions_cache()

    # Return updated session
    updated_session = load_session_by_id(session_id)
    if updated_session is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reload session after update",
        )
    return updated_session


def extract_first_turn_from_wire(session_dir: Path) -> tuple[str, str] | None:
    """Extract the first turn's user message and assistant response from wire.jsonl.

    Returns:
        tuple[str, str] | None: (user_message, assistant_response) or None if not found
    """
    wire_file = session_dir / "wire.jsonl"
    if not wire_file.exists():
        return None

    user_message: str | None = None
    assistant_response_parts: list[str] = []
    in_first_turn = False

    try:
        with open(wire_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    message = record.get("message", {})
                    msg_type = message.get("type")

                    if msg_type == "TurnBegin":
                        if in_first_turn:
                            # Second turn started, stop
                            break
                        in_first_turn = True
                        user_input = message.get("payload", {}).get("user_input")
                        if user_input:
                            from kosong.message import Message

                            msg = Message(role="user", content=user_input)
                            user_message = msg.extract_text(" ")

                    elif msg_type == "ContentPart" and in_first_turn:
                        payload = message.get("payload", {})
                        if payload.get("type") == "text" and payload.get("text"):
                            assistant_response_parts.append(payload["text"])

                    elif msg_type == "TurnEnd" and in_first_turn:
                        break

                except json.JSONDecodeError:
                    continue
    except OSError:
        return None

    if user_message and assistant_response_parts:
        return (user_message, "".join(assistant_response_parts))
    return None


@router.post("/{session_id}/generate-title", summary="Generate session title using AI")
async def generate_session_title(
    session_id: UUID,
    request: GenerateTitleRequest | None = None,
    runner: KimiCLIRunner = Depends(get_runner),
) -> GenerateTitleResponse:
    """Generate a concise session title using AI based on the first conversation turn.

    If request body is empty or parameters are missing, the backend will
    automatically read the first turn from wire.jsonl.
    """
    session = get_editable_session(session_id, runner)
    session_dir = session.kimi_cli_session.dir

    # Check if title was already generated (avoid duplicate calls)
    metadata_file = session_dir / "metadata.json"
    if metadata_file.exists():
        try:
            existing_metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            if existing_metadata.get("title_generated"):
                # Title already auto-generated, return it without regenerating
                return GenerateTitleResponse(title=existing_metadata.get("title", "Untitled"))
        except (json.JSONDecodeError, OSError):
            pass

    # Get message content: prefer request parameters, otherwise read from wire.jsonl
    user_message = request.user_message if request else None
    assistant_response = request.assistant_response if request else None

    if not user_message or not assistant_response:
        first_turn = extract_first_turn_from_wire(session_dir)
        if first_turn:
            user_message, assistant_response = first_turn

    # If still no user message, return default title
    if not user_message:
        return GenerateTitleResponse(title="Untitled")

    # Fallback title from user message (used if AI generation fails)
    from textwrap import shorten

    user_text = user_message.strip()
    user_text = " ".join(user_text.split())
    fallback_title = shorten(user_text, width=50, placeholder="...") or "Untitled"

    # Try to generate title using AI
    title = fallback_title
    try:
        from kosong import generate
        from kosong.message import Message

        from kimi_cli.config import load_config
        from kimi_cli.llm import create_llm

        config = load_config()
        model_name = config.default_model

        if model_name and model_name in config.models:
            model_config = config.models[model_name]
            provider_config = config.providers.get(model_config.provider)

            if provider_config:
                llm = create_llm(provider_config, model_config)

                if llm:
                    system_prompt = (
                        "Generate a concise session title (max 50 characters) "
                        "based on the conversation. "
                        "Only respond with the title text, nothing else. "
                        "No quotes, no explanation."
                    )

                    prompt = f"""User: {user_message[:300]}
Assistant: {(assistant_response or "")[:300]}

Title:"""

                    result = await generate(
                        chat_provider=llm.chat_provider,
                        system_prompt=system_prompt,
                        tools=[],
                        history=[Message(role="user", content=prompt)],
                    )

                    generated_title = result.message.extract_text().strip()
                    # Remove quotes if present
                    generated_title = generated_title.strip("\"'")

                    if generated_title and len(generated_title) <= 50:
                        title = generated_title
                    elif generated_title:
                        title = shorten(generated_title, width=50, placeholder="...")

    except Exception as e:
        logger.warning(f"Failed to generate title using AI: {e}")
        # Keep fallback_title

    # Save the generated title to metadata.json
    metadata_data = {}
    if metadata_file.exists():
        try:
            metadata_data = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            metadata_data = {}

    metadata_data["title"] = title
    metadata_data["title_generated"] = True
    metadata_json = json.dumps(metadata_data, ensure_ascii=False, indent=2)
    metadata_file.write_text(metadata_json, encoding="utf-8")

    # Invalidate cache
    invalidate_sessions_cache()

    return GenerateTitleResponse(title=title)


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
    expected_token = getattr(websocket.app.state, "session_token", None)
    enforce_origin = getattr(websocket.app.state, "enforce_origin", False)
    allowed_origins = getattr(websocket.app.state, "allowed_origins", [])
    lan_only = getattr(websocket.app.state, "lan_only", False)

    # LAN-only check
    if lan_only:
        client_ip = websocket.client.host if websocket.client else None
        if client_ip and not is_private_ip(client_ip):
            await websocket.close(code=4403, reason="Access denied: LAN only")
            return

    if enforce_origin:
        origin = websocket.headers.get("origin")
        if origin and not is_origin_allowed(origin, allowed_origins):
            await websocket.close(code=4403, reason="Origin not allowed")
            return

    if expected_token:
        token = websocket.query_params.get("token")
        if not verify_token(token, expected_token):
            await websocket.close(code=4401, reason="Auth required")
            return

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

        # Check if WebSocket is still connected before continuing
        if not await send_history_complete(websocket):
            logger.debug("WebSocket disconnected during history replay")
            return

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


@router.get("/{session_id}/git-diff", summary="Get git diff stats")
async def get_session_git_diff(session_id: UUID) -> GitDiffStats:
    """get git diff stats for the session's work directory"""
    session = load_session_by_id(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    work_dir = Path(str(session.kimi_cli_session.work_dir))

    # Check if it is a git repository
    if not (work_dir / ".git").exists():
        return GitDiffStats(is_git_repo=False)

    try:
        files: list[GitFileDiff] = []
        total_add, total_del = 0, 0

        # Check if HEAD exists (repo has at least one commit)
        check_proc = await asyncio.create_subprocess_exec(
            "git",
            "rev-parse",
            "--verify",
            "HEAD",
            cwd=str(work_dir),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await check_proc.wait()
        has_head = check_proc.returncode == 0

        if has_head:
            # Execute git diff --numstat HEAD (including staged and unstaged)
            proc = await asyncio.create_subprocess_exec(
                "git",
                "diff",
                "--numstat",
                "HEAD",
                cwd=str(work_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)

            # Parse output
            for line in stdout.decode().strip().split("\n"):
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) >= 3:
                    add = int(parts[0]) if parts[0] != "-" else 0
                    dele = int(parts[1]) if parts[1] != "-" else 0
                    total_add += add
                    total_del += dele
                    # Determine file status
                    file_status: str = "modified"
                    if dele == 0 and add > 0:
                        file_status = "added"
                    elif add == 0 and dele > 0:
                        file_status = "deleted"
                    files.append(
                        GitFileDiff(
                            path=parts[2],
                            additions=add,
                            deletions=dele,
                            status=file_status,  # type: ignore[arg-type]
                        )
                    )

        # Also get untracked files (new files not yet added to git)
        untracked_proc = await asyncio.create_subprocess_exec(
            "git",
            "ls-files",
            "--others",
            "--exclude-standard",
            cwd=str(work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        untracked_stdout, _ = await asyncio.wait_for(untracked_proc.communicate(), timeout=5.0)

        # Add untracked files to the result
        for line in untracked_stdout.decode().strip().split("\n"):
            if line:
                files.append(
                    GitFileDiff(
                        path=line,
                        additions=0,  # Cannot count lines for untracked files
                        deletions=0,
                        status="added",
                    )
                )

        if not has_head:
            return GitDiffStats(
                is_git_repo=True,
                has_changes=len(files) > 0,
                total_additions=0,
                total_deletions=0,
                files=files,
            )

        return GitDiffStats(
            is_git_repo=True,
            has_changes=len(files) > 0,
            total_additions=total_add,
            total_deletions=total_del,
            files=files,
        )
    except TimeoutError:
        return GitDiffStats(is_git_repo=True, error="Git command timed out")
    except Exception as e:
        return GitDiffStats(is_git_repo=True, error=str(e))
