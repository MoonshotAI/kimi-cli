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
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from pydantic import ConfigDict, Field

from kimi_cli.metadata import load_metadata
from kimi_cli.session import Session as KimiCLISession
from kimi_cli.web.models import Session
from kimi_cli.wire.file import WireFile

# Cache configuration
CACHE_TTL = 5.0  # seconds - balance between freshness and performance

_sessions_cache: list[JointSession] | None = None
_cache_timestamp: float = 0.0


def invalidate_sessions_cache() -> None:
    """Clear the sessions cache.

    Call this after any mutation (create/update/delete).
    This ensures the next read sees fresh data.
    """
    global _sessions_cache, _cache_timestamp
    _sessions_cache = None
    _cache_timestamp = 0.0


class JointSession(Session):
    """Combined session model with both web UI and kimi-cli session data."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    kimi_cli_session: KimiCLISession = Field(exclude=True)


def load_all_sessions() -> list[JointSession]:
    """Load all sessions from all work directories."""
    metadata = load_metadata()
    sessions: list[JointSession] = []

    for wd in metadata.work_dirs:
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

        # Build sessions from session directories
        for session_dir, context_file in session_dirs:
            try:
                session_id = UUID(session_dir.name)
            except (ValueError, AttributeError, TypeError):
                continue

            if context_file.stat().st_size == 0:
                continue

            # Create kimi-cli session object
            from kaos.path import KaosPath

            kimi_session = KimiCLISession(
                id=str(session_id),
                work_dir=KaosPath.unsafe_from_local_path(Path(wd.path)),
                work_dir_meta=wd,
                context_file=context_file,
                wire_file=WireFile(session_dir / "wire.jsonl"),
                title="",
                updated_at=0.0,
            )

            # Derive title from first message by reading wire.jsonl directly
            title = f"Untitled ({session_id})"
            try:
                import json
                from textwrap import shorten

                from kosong.message import Message

                wire_file = session_dir / "wire.jsonl"
                if wire_file.exists():
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
                                        title = shorten(text, width=50)
                                        title = f"{title} ({session_id})"
                                        break
                            except json.JSONDecodeError:
                                continue
            except Exception:
                # Ignore errors reading wire.jsonl - use default title
                pass

            kimi_session.title = title
            kimi_session.updated_at = context_file.stat().st_mtime

            session = JointSession(
                session_id=session_id,
                title=title,
                last_updated=datetime.fromtimestamp(context_file.stat().st_mtime, tz=UTC),
                is_running=False,
                status=None,
                work_dir=wd.path,
                session_dir=str(session_dir),
                kimi_cli_session=kimi_session,
            )
            sessions.append(session)

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


def load_session_by_id(id: UUID) -> JointSession | None:
    """Load a session by ID.

    This function first checks the cache/disk scan, then falls back to
    directly constructing the session from metadata if not found (handles
    newly created sessions with empty context files).
    """
    # First, try the normal scan (which may skip empty sessions)
    for session in load_all_sessions():
        if session.session_id == id:
            return session

    # Fallback: directly look up the session from metadata
    # This handles newly created sessions with empty context.jsonl files
    metadata = load_metadata()
    session_id_str = str(id)

    for wd in metadata.work_dirs:
        session_dir = wd.sessions_dir / session_id_str
        context_file = session_dir / "context.jsonl"

        if context_file.exists():
            from kaos.path import KaosPath

            kimi_session = KimiCLISession(
                id=session_id_str,
                work_dir=KaosPath.unsafe_from_local_path(Path(wd.path)),
                work_dir_meta=wd,
                context_file=context_file,
                wire_file=WireFile(session_dir / "wire.jsonl"),
                title=f"New Session ({id})",
                updated_at=context_file.stat().st_mtime,
            )

            return JointSession(
                session_id=id,
                title=kimi_session.title,
                last_updated=datetime.fromtimestamp(context_file.stat().st_mtime, tz=UTC),
                is_running=False,
                status=None,
                work_dir=wd.path,
                session_dir=str(session_dir),
                kimi_cli_session=kimi_session,
            )

    return None


if __name__ == "__main__":
    start_time = time.time()
    sessions = load_all_sessions()
    print(f"Found {len(sessions)} Sessions in {time.time() - start_time:.2f} seconds:")
    for session in sessions:
        print(session.last_updated, session.session_id, session.title)
