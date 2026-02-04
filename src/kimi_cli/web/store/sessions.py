"""Session storage with simple in-memory caching for web UI.

## Design Philosophy

This module uses a simple cache-aside pattern with TTL fallback:

1. **Cache on read**: First read populates cache, subsequent reads hit cache
2. **Invalidate on write**: API mutations call invalidate_sessions_cache()
3. **TTL fallback**: Cache expires after CACHE_TTL seconds as safety net

## Applicable Scope

This design works well when:
- Single worker process (e.g., `uvicorn app:app` without -w flag)
- All mutations go through the same API
- Occasional staleness (up to CACHE_TTL) from external changes is acceptable
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from kimi_cli.metadata import WorkDirMeta, load_metadata
from kimi_cli.session import Session as KimiCLISession
from kimi_cli.web.models import Session
from kimi_cli.wire.file import WireFile

# Cache configuration
CACHE_TTL = 5.0  # seconds - balance between freshness and performance
SESSION_METADATA_FILENAME = "metadata.json"

_sessions_cache: list[JointSession] | None = None
_cache_timestamp: float = 0.0
_sessions_index_cache: list[SessionIndexEntry] | None = None
_index_cache_timestamp: float = 0.0


def invalidate_sessions_cache() -> None:
    """Clear the sessions cache.

    Call this after any mutation (create/update/delete).
    This ensures the next read sees fresh data.
    """
    global _sessions_cache, _cache_timestamp, _sessions_index_cache, _index_cache_timestamp
    _sessions_cache = None
    _cache_timestamp = 0.0
    _sessions_index_cache = None
    _index_cache_timestamp = 0.0


class JointSession(Session):
    """Combined session model with both web UI and kimi-cli session data."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    kimi_cli_session: KimiCLISession = Field(exclude=True)


class SessionMetadata(BaseModel):
    """Session metadata stored in metadata.json."""

    session_id: str
    title: str = "Untitled"
    title_generated: bool = False
    title_generate_attempts: int = 0
    wire_mtime: float | None = None


@dataclass(slots=True)
class SessionIndexEntry:
    session_id: UUID
    session_dir: Path
    context_file: Path
    work_dir: str
    work_dir_meta: WorkDirMeta
    last_updated: datetime
    title: str
    metadata: SessionMetadata | None


def load_session_metadata(session_dir: Path, session_id: str) -> SessionMetadata:
    """Load session metadata from metadata.json, or create default if not exists."""
    metadata_file = session_dir / SESSION_METADATA_FILENAME
    if not metadata_file.exists():
        return SessionMetadata(session_id=session_id)
    try:
        import json

        data = json.loads(metadata_file.read_text(encoding="utf-8"))
        # Ensure session_id is set
        data["session_id"] = session_id
        return SessionMetadata.model_validate(data)
    except Exception:
        return SessionMetadata(session_id=session_id)


def save_session_metadata(session_dir: Path, metadata: SessionMetadata) -> None:
    """Save session metadata to metadata.json."""
    if not session_dir.exists():
        return
    metadata_file = session_dir / SESSION_METADATA_FILENAME
    try:
        import json

        metadata_file.write_text(
            json.dumps(metadata.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def _derive_title_from_wire(session_dir: Path) -> str:
    wire_file = session_dir / "wire.jsonl"
    if not wire_file.exists():
        return "Untitled"

    try:
        import json
        from textwrap import shorten

        from kosong.message import Message

        with open(wire_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    message = record.get("message", {})
                    if message.get("type") == "TurnBegin":
                        user_input = message.get("payload", {}).get("user_input")
                        if user_input:
                            msg = Message(role="user", content=user_input)
                            text = msg.extract_text(" ")
                            return shorten(text, width=300)
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return "Untitled"


def _iter_session_dirs(wd: WorkDirMeta) -> list[tuple[Path, Path]]:
    session_dirs: list[tuple[Path, Path]] = []

    # Latest sessions
    for context_file in wd.sessions_dir.glob("*/context.jsonl"):
        session_dir = context_file.parent
        session_dirs.append((session_dir, context_file))

    # Legacy sessions
    for context_file in wd.sessions_dir.glob("*.jsonl"):
        session_dir = context_file.parent / context_file.stem
        converted_context_file = session_dir / "context.jsonl"
        if converted_context_file.exists():
            continue
        session_dirs.append((session_dir, context_file))

    return session_dirs


def _ensure_title(entry: SessionIndexEntry, *, refresh: bool) -> None:
    """Ensure session has a title, updating metadata if needed.

    Logic:
    - If title exists and is not "Untitled": only update wire_mtime if changed
    - If title is empty or "Untitled": derive from wire.jsonl, don't touch title_generated
    """
    session_id_str = str(entry.session_id)
    wire_file = entry.session_dir / "wire.jsonl"
    wire_mtime = wire_file.stat().st_mtime if wire_file.exists() else None

    # Load or create metadata
    metadata = entry.metadata
    if metadata is None:
        metadata = load_session_metadata(entry.session_dir, session_id_str)
        entry.metadata = metadata

    # Case 1: title exists and is not "Untitled" - only update wire_mtime
    if metadata.title and metadata.title != "Untitled":
        entry.title = metadata.title
        if metadata.wire_mtime != wire_mtime:
            metadata = metadata.model_copy(update={"wire_mtime": wire_mtime})
            save_session_metadata(entry.session_dir, metadata)
            entry.metadata = metadata
        return

    # Case 2: title is empty or "Untitled"
    # If not refreshing, just use current title
    if not refresh:
        entry.title = metadata.title if metadata.title else "Untitled"
        return

    # Derive title from wire.jsonl
    title = _derive_title_from_wire(entry.session_dir)
    entry.title = title

    # Update metadata: set title and wire_mtime, but keep title_generated unchanged
    metadata = metadata.model_copy(
        update={
            "title": title,
            "wire_mtime": wire_mtime,
        }
    )
    save_session_metadata(entry.session_dir, metadata)
    entry.metadata = metadata


def _build_kimi_session(entry: SessionIndexEntry) -> KimiCLISession:
    from kaos.path import KaosPath

    return KimiCLISession(
        id=str(entry.session_id),
        work_dir=KaosPath.unsafe_from_local_path(Path(entry.work_dir)),
        work_dir_meta=entry.work_dir_meta,
        context_file=entry.context_file,
        wire_file=WireFile(entry.session_dir / "wire.jsonl"),
        title=entry.title,
        updated_at=entry.last_updated.timestamp(),
    )


def _build_joint_session(entry: SessionIndexEntry) -> JointSession:
    kimi_session = _build_kimi_session(entry)
    return JointSession(
        session_id=entry.session_id,
        title=entry.title,
        last_updated=entry.last_updated,
        is_running=False,
        status=None,
        work_dir=entry.work_dir,
        session_dir=str(entry.session_dir),
        kimi_cli_session=kimi_session,
    )


def _build_sessions_index() -> list[SessionIndexEntry]:
    metadata = load_metadata()
    entries: list[SessionIndexEntry] = []

    for wd in metadata.work_dirs:
        for session_dir, context_file in _iter_session_dirs(wd):
            try:
                session_id = UUID(session_dir.name)
            except (ValueError, AttributeError, TypeError):
                continue

            if not context_file.exists():
                continue

            last_updated = datetime.fromtimestamp(context_file.stat().st_mtime, tz=UTC)
            session_metadata = load_session_metadata(session_dir, str(session_id))
            title = session_metadata.title if session_metadata.title else "Untitled"

            entries.append(
                SessionIndexEntry(
                    session_id=session_id,
                    session_dir=session_dir,
                    context_file=context_file,
                    work_dir=wd.path,
                    work_dir_meta=wd,
                    last_updated=last_updated,
                    title=title,
                    metadata=session_metadata,
                )
            )

    entries.sort(key=lambda x: (x.last_updated, str(x.session_id)), reverse=True)
    return entries


def _load_sessions_index_cached() -> list[SessionIndexEntry]:
    global _sessions_index_cache, _index_cache_timestamp

    now = time.time()
    if _sessions_index_cache is not None and (now - _index_cache_timestamp) < CACHE_TTL:
        return _sessions_index_cache

    _sessions_index_cache = _build_sessions_index()
    _index_cache_timestamp = now
    return _sessions_index_cache


def load_all_sessions() -> list[JointSession]:
    """Load all sessions from all work directories."""
    entries = _load_sessions_index_cached()
    sessions: list[JointSession] = []

    for entry in entries:
        _ensure_title(entry, refresh=False)
        sessions.append(_build_joint_session(entry))

    sessions.sort(key=lambda x: x.last_updated, reverse=True)
    return sessions


def load_all_sessions_cached() -> list[JointSession]:
    """Cached version of load_all_sessions().

    Returns cached data if:
    - Cache exists AND
    - Cache is younger than CACHE_TTL

    Otherwise, refreshes from disk and updates cache.
    """
    global _sessions_cache, _cache_timestamp

    now = time.time()
    if _sessions_cache is not None and (now - _cache_timestamp) < CACHE_TTL:
        return _sessions_cache

    _sessions_cache = load_all_sessions()
    _cache_timestamp = now
    return _sessions_cache


def load_sessions_page(
    *,
    limit: int = 100,
    offset: int = 0,
    query: str | None = None,
) -> list[JointSession]:
    """Load a paginated list of sessions, optionally filtered by query."""
    entries = list(_load_sessions_index_cached())

    if query:
        query_text = query.strip().lower()
        if query_text:
            for entry in entries:
                _ensure_title(entry, refresh=True)
            entries = [
                entry
                for entry in entries
                if query_text in entry.title.lower() or query_text in (entry.work_dir or "").lower()
            ]

    if offset < 0:
        offset = 0
    if limit <= 0:
        limit = 100

    page_entries = entries[offset : offset + limit]

    if not query:
        for entry in page_entries:
            if entry.metadata is None or not entry.title or entry.title == "Untitled":
                _ensure_title(entry, refresh=True)

    return [_build_joint_session(entry) for entry in page_entries]


def load_session_by_id(id: UUID) -> JointSession | None:
    """Load a session by ID.

    This function first checks the cache/disk scan, then falls back to
    directly constructing the session from metadata if not found (handles
    newly created sessions with empty context files).
    """
    global_metadata = load_metadata()
    session_id_str = str(id)

    for wd in global_metadata.work_dirs:
        session_dir = wd.sessions_dir / session_id_str
        context_file = session_dir / "context.jsonl"

        if context_file.exists():
            last_updated = datetime.fromtimestamp(context_file.stat().st_mtime, tz=UTC)
            session_metadata = load_session_metadata(session_dir, session_id_str)
            title = session_metadata.title if session_metadata.title else "Untitled"
            entry = SessionIndexEntry(
                session_id=id,
                session_dir=session_dir,
                context_file=context_file,
                work_dir=wd.path,
                work_dir_meta=wd,
                last_updated=last_updated,
                title=title,
                metadata=session_metadata,
            )
            _ensure_title(entry, refresh=True)
            return _build_joint_session(entry)

        # Legacy sessions: context.jsonl stored directly in sessions_dir
        legacy_context = wd.sessions_dir / f"{session_id_str}.jsonl"
        if legacy_context.exists():
            last_updated = datetime.fromtimestamp(legacy_context.stat().st_mtime, tz=UTC)
            session_metadata = load_session_metadata(session_dir, session_id_str)
            title = session_metadata.title if session_metadata.title else "Untitled"
            entry = SessionIndexEntry(
                session_id=id,
                session_dir=session_dir,
                context_file=legacy_context,
                work_dir=wd.path,
                work_dir_meta=wd,
                last_updated=last_updated,
                title=title,
                metadata=session_metadata,
            )
            _ensure_title(entry, refresh=True)
            return _build_joint_session(entry)

    return None


if __name__ == "__main__":
    start_time = time.time()
    sessions = load_all_sessions()
    print(f"Found {len(sessions)} Sessions in {time.time() - start_time:.2f} seconds:")
    for session in sessions:
        print(session.last_updated, session.session_id, session.title)
