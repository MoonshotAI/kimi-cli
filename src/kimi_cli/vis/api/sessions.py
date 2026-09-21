"""Vis API for reading session tracing data."""

from __future__ import annotations

import contextlib
import io
import json
import logging
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any
from uuid import uuid4

import aiofiles
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from kimi_cli.metadata import load_metadata
from kimi_cli.share import get_share_dir
from kimi_cli.wire.file import WireFileMetadata, parse_wire_file_line

router = APIRouter(prefix="/api/vis", tags=["vis"])
logger = logging.getLogger(__name__)


def collect_events(
    msg_type: str,
    payload: dict[str, Any],
    out: list[tuple[str, dict[str, Any]]],
) -> None:
    """Recursively unwrap SubagentEvent and collect (type, payload) pairs."""
    if msg_type == "SubagentEvent":
        inner: dict[str, Any] | None = payload.get("event")
        if isinstance(inner, dict):
            inner_type: str = inner.get("type", "")
            inner_payload: dict[str, Any] = inner.get("payload", {})
            if inner_type:
                collect_events(inner_type, inner_payload, out)
    else:
        out.append((msg_type, payload))


_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_IMPORTED_HASH = "__imported__"


def _get_imported_root() -> Path:
    """Return the root directory for imported sessions."""
    return get_share_dir() / "imported_sessions"


def _find_session_dir(work_dir_hash: str, session_id: str) -> Path | None:
    """Find session directory by work_dir_hash and session_id."""
    if not _SESSION_ID_RE.match(session_id):
        return None
    if work_dir_hash == _IMPORTED_HASH:
        session_dir = _get_imported_root() / session_id
        if session_dir.is_dir():
            return session_dir
        return None
    if not _SESSION_ID_RE.match(work_dir_hash):
        return None
    sessions_root = get_share_dir() / "sessions"
    session_dir = sessions_root / work_dir_hash / session_id
    if session_dir.is_dir():
        return session_dir
    return None


def get_work_dir_for_hash(hash_dir_name: str) -> str | None:
    """Look up the work directory path from metadata for a given hash directory name."""
    try:
        metadata = load_metadata()
    except Exception:
        return None
    from hashlib import md5

    from kaos.local import local_kaos

    for wd in metadata.work_dirs:
        path_md5 = md5(wd.path.encode(encoding="utf-8")).hexdigest()
        dir_basename = path_md5 if wd.kaos == local_kaos.name else f"{wd.kaos}_{path_md5}"
        if dir_basename == hash_dir_name:
            return wd.path
    return None


def _extract_title_from_wire(wire_path: Path, max_bytes: int = 8192) -> tuple[str, int]:
    """Extract title and turn count from the beginning of wire.jsonl.

    Only reads up to *max_bytes* to avoid blocking on large files.
    Returns (title, turn_count).
    """
    title = ""
    turn_count = 0
    try:
        with wire_path.open(encoding="utf-8") as f:
            bytes_read = 0
            for line in f:
                bytes_read += len(line.encode("utf-8"))
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = parse_wire_file_line(line)
                except Exception:
                    continue
                if isinstance(parsed, WireFileMetadata):
                    continue
                if parsed.message.type == "TurnBegin":
                    turn_count += 1
                    if turn_count == 1:
                        user_input = parsed.message.payload.get("user_input", "")
                        if isinstance(user_input, str):
                            title = user_input[:100]
                        elif isinstance(user_input, list) and user_input:
                            first = user_input[0]
                            if isinstance(first, dict):
                                title = str(first.get("text", ""))[:100]
                # Stop once we exceed the byte budget — title is extracted from
                # the first TurnBegin so this is a hard upper bound on I/O.
                if bytes_read > max_bytes:
                    break
    except Exception:
        pass
    return title, turn_count


def _scan_session_dir(
    session_dir: Path,
    work_dir_hash: str,
    work_dir: str | None,
    *,
    imported: bool = False,
) -> dict[str, Any] | None:
    """Extract session info from a session directory."""
    if not session_dir.is_dir():
        return None

    wire_path = session_dir / "wire.jsonl"
    context_path = session_dir / "context.jsonl"
    state_path = session_dir / "state.json"

    wire_exists = wire_path.exists()
    context_exists = context_path.exists()
    state_exists = state_path.exists()

    # Get last updated time from most recent file
    mtimes: list[float] = []
    wire_size = context_size = state_size = 0
    if wire_exists:
        st = wire_path.stat()
        mtimes.append(st.st_mtime)
        wire_size = st.st_size
    if context_exists:
        st = context_path.stat()
        mtimes.append(st.st_mtime)
        context_size = st.st_size
    if state_exists:
        st = state_path.stat()
        mtimes.append(st.st_mtime)
        state_size = st.st_size

    # Read title from SessionState (source of truth), fall back to wire-derived title
    from kimi_cli.session_state import load_session_state

    session_state = load_session_state(session_dir)

    title = ""
    turn_count = 0
    if wire_exists:
        title, turn_count = _extract_title_from_wire(wire_path)
    if session_state.custom_title:
        title = session_state.custom_title

    # Count sub-agents
    subagent_count = 0
    subagents_dir = session_dir / "subagents"
    if subagents_dir.is_dir():
        subagent_count = sum(1 for p in subagents_dir.iterdir() if p.is_dir())

    return {
        "session_id": session_dir.name,
        "session_dir": str(session_dir),
        "work_dir": work_dir,
        "work_dir_hash": work_dir_hash,
        "title": title,
        "last_updated": max(mtimes) if mtimes else 0,
        "has_wire": wire_exists,
        "has_context": context_exists,
        "has_state": state_exists,
        "metadata": session_state.model_dump(mode="json"),
        "wire_size": wire_size,
        "context_size": context_size,
        "state_size": state_size,
        "total_size": wire_size + context_size + state_size,
        "turns": turn_count,
        "imported": imported,
        "subagent_count": subagent_count,
    }


def _list_sessions_sync() -> list[dict[str, Any]]:
    """Synchronous session scanning — called from a thread pool."""
    results: list[dict[str, Any]] = []

    sessions_root = get_share_dir() / "sessions"
    if sessions_root.exists():
        for work_dir_hash_dir in sessions_root.iterdir():
            if not work_dir_hash_dir.is_dir():
                continue
            work_dir = get_work_dir_for_hash(work_dir_hash_dir.name)
            for session_dir in work_dir_hash_dir.iterdir():
                info = _scan_session_dir(session_dir, work_dir_hash_dir.name, work_dir)
                if info:
                    results.append(info)

    imported_root = _get_imported_root()
    if imported_root.exists():
        for session_dir in imported_root.iterdir():
            info = _scan_session_dir(
                session_dir,
                _IMPORTED_HASH,
                None,
                imported=True,
            )
            if info:
                results.append(info)

    results.sort(key=lambda s: s["last_updated"], reverse=True)
    return results


@router.get("/sessions")
async def list_sessions() -> list[dict[str, Any]]:
    """List all available sessions across all work directories."""
    import asyncio

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _list_sessions_sync)


@router.get("/sessions/{work_dir_hash}/{session_id}/wire")
async def get_wire_events(work_dir_hash: str, session_id: str) -> dict[str, Any]:
    """Read and parse wire.jsonl for a session."""
    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    wire_path = session_dir / "wire.jsonl"
    if not wire_path.exists():
        return {"total": 0, "events": []}

    events: list[dict[str, Any]] = []
    index = 0
    async with aiofiles.open(wire_path, encoding="utf-8") as f:
        async for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = parse_wire_file_line(line)
            except Exception:
                logger.debug("Skipped malformed line in %s", wire_path)
                continue
            if isinstance(parsed, WireFileMetadata):
                continue
            events.append(
                {
                    "index": index,
                    "timestamp": parsed.timestamp,
                    "type": parsed.message.type,
                    "payload": parsed.message.payload,
                }
            )
            index += 1

    return {"total": len(events), "events": events}


@router.get("/sessions/{work_dir_hash}/{session_id}/context")
async def get_context_messages(work_dir_hash: str, session_id: str) -> dict[str, Any]:
    """Read and parse context.jsonl for a session."""
    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    context_path = session_dir / "context.jsonl"
    if not context_path.exists():
        return {"total": 0, "messages": []}

    messages: list[dict[str, Any]] = []
    index = 0
    async with aiofiles.open(context_path, encoding="utf-8") as f:
        async for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("Skipped malformed line in %s", context_path)
                continue
            msg["index"] = index
            messages.append(msg)
            index += 1

    return {"total": len(messages), "messages": messages}


@router.get("/sessions/{work_dir_hash}/{session_id}/state")
async def get_session_state(work_dir_hash: str, session_id: str) -> dict[str, Any]:
    """Read state.json for a session."""
    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    state_path = session_dir / "state.json"
    if not state_path.exists():
        return {}

    async with aiofiles.open(state_path, encoding="utf-8") as f:
        content = await f.read()
    try:
        return json.loads(content)
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=500, detail="Invalid state.json") from err


@router.get("/sessions/{work_dir_hash}/{session_id}/summary")
async def get_session_summary(work_dir_hash: str, session_id: str) -> dict[str, Any]:
    """Compute summary statistics for a session by scanning wire.jsonl."""
    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    wire_path = session_dir / "wire.jsonl"
    context_path = session_dir / "context.jsonl"
    state_path = session_dir / "state.json"

    wire_size = wire_path.stat().st_size if wire_path.exists() else 0
    context_size = context_path.stat().st_size if context_path.exists() else 0
    state_size = state_path.stat().st_size if state_path.exists() else 0

    zeros: dict[str, Any] = {
        "turns": 0,
        "steps": 0,
        "tool_calls": 0,
        "errors": 0,
        "compactions": 0,
        "duration_sec": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "wire_size": wire_size,
        "context_size": context_size,
        "state_size": state_size,
        "total_size": wire_size + context_size + state_size,
    }

    if not wire_path.exists():
        return zeros

    turns = steps = tool_calls = errors = compactions = 0
    input_tokens = output_tokens = 0
    first_ts = 0.0
    last_ts = 0.0

    async with aiofiles.open(wire_path, encoding="utf-8") as f:
        async for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = parse_wire_file_line(line)
            except Exception:
                logger.debug("Skipped malformed line in %s", wire_path)
                continue
            if isinstance(parsed, WireFileMetadata):
                continue

            ts = parsed.timestamp
            msg_type = parsed.message.type
            payload = parsed.message.payload

            if first_ts == 0:
                first_ts = ts
            last_ts = ts

            # Collect (type, payload) pairs, unwrapping SubagentEvent recursively
            events_to_process: list[tuple[str, dict[str, Any]]] = []
            collect_events(msg_type, payload, events_to_process)

            for ev_type, ev_payload in events_to_process:
                if ev_type == "TurnBegin":
                    turns += 1
                elif ev_type == "StepBegin":
                    steps += 1
                elif ev_type == "ToolCall":
                    tool_calls += 1
                elif ev_type == "CompactionBegin":
                    compactions += 1
                elif ev_type == "StepInterrupted":
                    errors += 1
                elif ev_type == "ToolResult":
                    rv: dict[str, Any] | None = ev_payload.get("return_value")
                    if isinstance(rv, dict) and rv.get("is_error"):
                        errors += 1
                elif ev_type == "ApprovalResponse":
                    if ev_payload.get("response") == "reject":
                        errors += 1
                elif ev_type == "StatusUpdate":
                    tu: dict[str, Any] | None = ev_payload.get("token_usage")
                    if isinstance(tu, dict):
                        input_tokens += (
                            int(tu.get("input_other", 0))
                            + int(tu.get("input_cache_read", 0))
                            + int(tu.get("input_cache_creation", 0))
                        )
                        output_tokens += int(tu.get("output", 0))

    return {
        "turns": turns,
        "steps": steps,
        "tool_calls": tool_calls,
        "errors": errors,
        "compactions": compactions,
        "duration_sec": last_ts - first_ts if last_ts > first_ts else 0,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "wire_size": wire_size,
        "context_size": context_size,
        "state_size": state_size,
        "total_size": wire_size + context_size + state_size,
    }


@router.get("/sessions/{work_dir_hash}/{session_id}/subagents")
def list_subagents(work_dir_hash: str, session_id: str) -> list[dict[str, Any]]:
    """List all sub-agents for a session."""
    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    subagents_dir = session_dir / "subagents"
    if not subagents_dir.is_dir():
        return []

    results: list[dict[str, Any]] = []
    for entry in subagents_dir.iterdir():
        if not entry.is_dir():
            continue
        if not _SESSION_ID_RE.match(entry.name):
            continue

        meta_path = entry / "meta.json"
        meta: dict[str, Any] = {}
        if meta_path.exists():
            with contextlib.suppress(Exception):
                meta = json.loads(meta_path.read_text(encoding="utf-8"))

        wire_path = entry / "wire.jsonl"
        context_path = entry / "context.jsonl"
        results.append(
            {
                "agent_id": meta.get("agent_id", entry.name),
                "subagent_type": meta.get("subagent_type", "unknown"),
                "status": meta.get("status", "unknown"),
                "description": meta.get("description", ""),
                "created_at": meta.get("created_at", 0),
                "updated_at": meta.get("updated_at", 0),
                "last_task_id": meta.get("last_task_id"),
                "launch_spec": meta.get("launch_spec", {}),
                "wire_size": wire_path.stat().st_size if wire_path.exists() else 0,
                "context_size": context_path.stat().st_size if context_path.exists() else 0,
            }
        )

    results.sort(key=lambda s: s.get("created_at", 0))
    return results


@router.get("/sessions/{work_dir_hash}/{session_id}/subagents/{agent_id}/wire")
async def get_subagent_wire_events(
    work_dir_hash: str, session_id: str, agent_id: str
) -> dict[str, Any]:
    """Read and parse wire.jsonl for a specific sub-agent."""
    if not _SESSION_ID_RE.match(agent_id):
        raise HTTPException(status_code=400, detail="Invalid agent ID")

    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    wire_path = session_dir / "subagents" / agent_id / "wire.jsonl"
    if not wire_path.exists():
        return {"total": 0, "events": []}

    events: list[dict[str, Any]] = []
    index = 0
    async with aiofiles.open(wire_path, encoding="utf-8") as f:
        async for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = parse_wire_file_line(line)
            except Exception:
                logger.debug("Skipped malformed line in %s", wire_path)
                continue
            if isinstance(parsed, WireFileMetadata):
                continue
            events.append(
                {
                    "index": index,
                    "timestamp": parsed.timestamp,
                    "type": parsed.message.type,
                    "payload": parsed.message.payload,
                }
            )
            index += 1

    return {"total": len(events), "events": events}


@router.get("/sessions/{work_dir_hash}/{session_id}/subagents/{agent_id}/context")
async def get_subagent_context(
    work_dir_hash: str, session_id: str, agent_id: str
) -> dict[str, Any]:
    """Read and parse context.jsonl for a specific sub-agent."""
    if not _SESSION_ID_RE.match(agent_id):
        raise HTTPException(status_code=400, detail="Invalid agent ID")

    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    context_path = session_dir / "subagents" / agent_id / "context.jsonl"
    if not context_path.exists():
        return {"total": 0, "messages": []}

    messages: list[dict[str, Any]] = []
    index = 0
    async with aiofiles.open(context_path, encoding="utf-8") as f:
        async for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("Skipped malformed line in %s", context_path)
                continue
            msg["index"] = index
            messages.append(msg)
            index += 1

    return {"total": len(messages), "messages": messages}


@router.get("/sessions/{work_dir_hash}/{session_id}/subagents/{agent_id}/meta")
async def get_subagent_meta(work_dir_hash: str, session_id: str, agent_id: str) -> dict[str, Any]:
    """Read meta.json for a specific sub-agent."""
    if not _SESSION_ID_RE.match(agent_id):
        raise HTTPException(status_code=400, detail="Invalid agent ID")

    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    meta_path = session_dir / "subagents" / agent_id / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Sub-agent not found")

    async with aiofiles.open(meta_path, encoding="utf-8") as f:
        content = await f.read()
    try:
        return json.loads(content)
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=500, detail="Invalid meta.json") from err


@router.get("/sessions/{work_dir_hash}/{session_id}/download")
def download_session(work_dir_hash: str, session_id: str) -> StreamingResponse:
    """Download all files in a session directory as a ZIP archive."""
    session_dir = _find_session_dir(work_dir_hash, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="Session not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(session_dir.rglob("*")):
            if file_path.is_file():
                zf.write(file_path, arcname=str(file_path.relative_to(session_dir)))
    buf.seek(0)

    filename = f"session-{session_id}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/sessions/import")
async def import_session(file: UploadFile) -> dict[str, Any]:
    """Import a session from an uploaded ZIP archive."""
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip files are accepted")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    # Reject uploads larger than 200 MB
    _MAX_UPLOAD_BYTES = 200 * 1024 * 1024
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 200 MB)")

    # Validate ZIP
    buf = io.BytesIO(content)
    try:
        zf = zipfile.ZipFile(buf, "r")
    except zipfile.BadZipFile as err:
        raise HTTPException(status_code=400, detail="Invalid ZIP file") from err

    with zf:
        names = zf.namelist()
        # Must contain wire.jsonl or context.jsonl at root or under exactly one directory
        _VALID_FILES = ("wire.jsonl", "context.jsonl")
        has_valid = any(
            n in _VALID_FILES or (n.count("/") == 1 and n.endswith(_VALID_FILES)) for n in names
        )
        if not has_valid:
            raise HTTPException(
                status_code=400,
                detail="ZIP must contain wire.jsonl or context.jsonl at the top level "
                "(or inside a single directory)",
            )

        session_id = uuid4().hex[:16]
        imported_root = _get_imported_root()
        session_dir = imported_root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Zip Slip protection: reject entries with path traversal or absolute paths
        for info in zf.infolist():
            if info.filename.startswith("/") or ".." in info.filename.split("/"):
                shutil.rmtree(session_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=400,
                    detail="ZIP contains unsafe path entries",
                )

        # Extract - handle both flat ZIPs and ZIPs with a single top-level directory
        zf.extractall(session_dir)

        # If all files are under a single subdirectory, flatten them
        entries = list(session_dir.iterdir())
        if len(entries) == 1 and entries[0].is_dir():
            nested_dir = entries[0]
            for item in nested_dir.iterdir():
                shutil.move(str(item), str(session_dir / item.name))
            nested_dir.rmdir()

    return {
        "session_id": session_id,
        "work_dir_hash": _IMPORTED_HASH,
    }


@router.delete("/sessions/{work_dir_hash}/{session_id}")
def delete_session(work_dir_hash: str, session_id: str) -> dict[str, str]:
    """Delete an imported session."""
    if work_dir_hash != _IMPORTED_HASH:
        raise HTTPException(status_code=403, detail="Only imported sessions can be deleted")

    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID")

    session_dir = _get_imported_root() / session_id
    if not session_dir.is_dir():
        raise HTTPException(status_code=404, detail="Session not found")

    shutil.rmtree(session_dir)
    return {"status": "deleted"}
