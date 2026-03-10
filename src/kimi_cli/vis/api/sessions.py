"""Vis API for reading session tracing data."""

from __future__ import annotations

import contextlib
import json
import logging
import re
from pathlib import Path
from typing import Any

import aiofiles
from fastapi import APIRouter, HTTPException

from kimi_cli.metadata import load_metadata
from kimi_cli.share import get_share_dir
from kimi_cli.wire.file import WireFileMetadata, parse_wire_file_line

router = APIRouter(prefix="/api/vis", tags=["vis"])
logger = logging.getLogger(__name__)


def _collect_events(
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
                _collect_events(inner_type, inner_payload, out)
    else:
        out.append((msg_type, payload))


_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _find_session_dir(work_dir_hash: str, session_id: str) -> Path | None:
    """Find session directory by work_dir_hash and session_id."""
    if not _SESSION_ID_RE.match(session_id) or not _SESSION_ID_RE.match(work_dir_hash):
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


@router.get("/sessions")
async def list_sessions() -> list[dict[str, Any]]:
    """List all available sessions across all work directories."""
    sessions_root = get_share_dir() / "sessions"
    if not sessions_root.exists():
        return []

    results: list[dict[str, Any]] = []
    for work_dir_hash_dir in sessions_root.iterdir():
        if not work_dir_hash_dir.is_dir():
            continue
        work_dir = get_work_dir_for_hash(work_dir_hash_dir.name)
        for session_dir in work_dir_hash_dir.iterdir():
            if not session_dir.is_dir():
                continue
            wire_path = session_dir / "wire.jsonl"
            context_path = session_dir / "context.jsonl"
            state_path = session_dir / "state.json"

            # Get last updated time from most recent file
            mtimes: list[float] = []
            for p in [wire_path, context_path, state_path]:
                if p.exists():
                    mtimes.append(p.stat().st_mtime)

            # Extract title and count turns from wire.jsonl
            title = ""
            turn_count = 0
            if wire_path.exists():
                try:
                    with wire_path.open(encoding="utf-8") as f:
                        for line in f:
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
                except Exception:
                    pass

            # File sizes (cheap stat calls)
            wire_size = wire_path.stat().st_size if wire_path.exists() else 0
            context_size = context_path.stat().st_size if context_path.exists() else 0
            state_size = state_path.stat().st_size if state_path.exists() else 0

            # Read metadata.json if it exists
            metadata_info: dict[str, Any] | None = None
            metadata_path = session_dir / "metadata.json"
            if metadata_path.exists():
                with contextlib.suppress(Exception):
                    metadata_info = json.loads(metadata_path.read_text(encoding="utf-8"))

            results.append(
                {
                    "session_id": session_dir.name,
                    "work_dir": work_dir,
                    "work_dir_hash": work_dir_hash_dir.name,
                    "title": title,
                    "last_updated": max(mtimes) if mtimes else 0,
                    "has_wire": wire_path.exists(),
                    "has_context": context_path.exists(),
                    "has_state": state_path.exists(),
                    "metadata": metadata_info,
                    "wire_size": wire_size,
                    "context_size": context_size,
                    "state_size": state_size,
                    "total_size": wire_size + context_size + state_size,
                    "turns": turn_count,
                }
            )

    results.sort(key=lambda s: s["last_updated"], reverse=True)
    return results


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
            _collect_events(msg_type, payload, events_to_process)

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
