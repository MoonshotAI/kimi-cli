from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from textwrap import shorten
from typing import Any, cast

import aiofiles
from kaos.path import KaosPath
from kosong.message import Message

from kimi_cli.metadata import WorkDirMeta, load_metadata, save_metadata
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import TurnBegin
from kimi_cli.wire.serde import deserialize_wire_message


@dataclass(slots=True, kw_only=True)
class Session:
    """A session of a work directory."""

    # static metadata
    id: str
    """The session ID."""
    work_dir: KaosPath
    """The absolute path of the work directory."""
    work_dir_meta: WorkDirMeta
    """The metadata of the work directory."""
    context_file: Path
    """The absolute path to the file storing the message history."""

    # refreshable metadata
    title: str
    """The title of the session."""
    updated_at: float
    """The timestamp of the last update to the session."""

    @property
    def dir(self) -> Path:
        """The absolute path of the session directory."""
        path = self.work_dir_meta.sessions_dir / self.id
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def wire_file(self) -> Path:
        """The file backend for persisting Wire messages."""
        return self.dir / "wire.jsonl"

    async def refresh(self) -> None:
        self.title = f"Untitled ({self.id})"
        self.updated_at = self.context_file.stat().st_mtime if self.context_file.exists() else 0.0

        if not self.wire_file.exists():
            return

        try:
            async with aiofiles.open(self.wire_file, encoding="utf-8") as f:
                async for line in f:
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if not isinstance(data, dict):
                        continue
                    message = cast(dict[str, Any], data).get("message")
                    wire_msg = deserialize_wire_message(message)
                    if isinstance(wire_msg, TurnBegin):
                        title = shorten(
                            Message(role="user", content=wire_msg.user_input).extract_text(" "),
                            width=50,
                        )
                        self.title = f"{title} ({self.id})"
                        return
        except Exception:
            logger.exception(
                "Failed to derive session title from wire file {file}:", file=self.wire_file
            )

    @staticmethod
    async def create(
        work_dir: KaosPath,
        session_id: str | None = None,
        _context_file: Path | None = None,
    ) -> Session:
        """Create a new session for a work directory."""
        work_dir = work_dir.canonical()
        logger.debug("Creating new session for work directory: {work_dir}", work_dir=work_dir)

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        if work_dir_meta is None:
            work_dir_meta = metadata.new_work_dir_meta(work_dir)

        if session_id is None:
            session_id = str(uuid.uuid4())
        session_dir = work_dir_meta.sessions_dir / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        if _context_file is None:
            context_file = session_dir / "context.jsonl"
        else:
            logger.warning(
                "Using provided context file: {context_file}", context_file=_context_file
            )
            _context_file.parent.mkdir(parents=True, exist_ok=True)
            if _context_file.exists():
                assert _context_file.is_file()
            context_file = _context_file

        if context_file.exists():
            # truncate if exists
            logger.warning(
                "Context file already exists, truncating: {context_file}", context_file=context_file
            )
            context_file.unlink()
        context_file.touch()

        save_metadata(metadata)

        session = Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
            title="",
            updated_at=0.0,
        )
        await session.refresh()
        return session

    @staticmethod
    async def find(work_dir: KaosPath, session_id: str) -> Session | None:
        """Find a session by work directory and session ID."""
        work_dir = work_dir.canonical()
        logger.debug(
            "Finding session for work directory: {work_dir}, session ID: {session_id}",
            work_dir=work_dir,
            session_id=session_id,
        )

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        if work_dir_meta is None:
            logger.debug("Work directory never been used")
            return None

        _migrate_session_context_file(work_dir_meta, session_id)

        session_dir = work_dir_meta.sessions_dir / session_id
        if not session_dir.is_dir():
            logger.debug("Session directory not found: {session_dir}", session_dir=session_dir)
            return None

        context_file = session_dir / "context.jsonl"
        if not context_file.exists():
            logger.debug(
                "Session context file not found: {context_file}", context_file=context_file
            )
            return None

        session = Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
            title="",
            updated_at=0.0,
        )
        await session.refresh()
        return session

    @staticmethod
    async def list(work_dir: KaosPath) -> list[Session]:
        """List all sessions for a work directory."""
        work_dir = work_dir.canonical()
        logger.debug("Listing sessions for work directory: {work_dir}", work_dir=work_dir)

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        if work_dir_meta is None:
            logger.debug("Work directory never been used")
            return []

        session_ids = {
            path.name if path.is_dir() else path.stem
            for path in work_dir_meta.sessions_dir.iterdir()
            if path.is_dir() or path.suffix == ".jsonl"
        }

        sessions: list[Session] = []
        for session_id in session_ids:
            _migrate_session_context_file(work_dir_meta, session_id)
            session_dir = work_dir_meta.sessions_dir / session_id
            if not session_dir.is_dir():
                logger.debug("Session directory not found: {session_dir}", session_dir=session_dir)
                continue
            context_file = session_dir / "context.jsonl"
            if not context_file.exists():
                logger.debug(
                    "Session context file not found: {context_file}", context_file=context_file
                )
                continue
            session = Session(
                id=session_id,
                work_dir=work_dir,
                work_dir_meta=work_dir_meta,
                context_file=context_file,
                title="",
                updated_at=0.0,
            )
            await session.refresh()
            sessions.append(session)
        sessions.sort(key=lambda session: session.updated_at, reverse=True)
        return sessions

    @staticmethod
    async def continue_(work_dir: KaosPath) -> Session | None:
        """Get the last session for a work directory."""
        work_dir = work_dir.canonical()
        logger.debug("Continuing session for work directory: {work_dir}", work_dir=work_dir)

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        if work_dir_meta is None:
            logger.debug("Work directory never been used")
            return None
        if work_dir_meta.last_session_id is None:
            logger.debug("Work directory never had a session")
            return None

        logger.debug(
            "Found last session for work directory: {session_id}",
            session_id=work_dir_meta.last_session_id,
        )
        return await Session.find(work_dir, work_dir_meta.last_session_id)


def _migrate_session_context_file(work_dir_meta: WorkDirMeta, session_id: str) -> None:
    old_context_file = work_dir_meta.sessions_dir / f"{session_id}.jsonl"
    new_context_file = work_dir_meta.sessions_dir / session_id / "context.jsonl"
    if old_context_file.exists() and not new_context_file.exists():
        new_context_file.parent.mkdir(parents=True, exist_ok=True)
        old_context_file.rename(new_context_file)
        logger.info(
            "Migrated session context file from {old} to {new}",
            old=old_context_file,
            new=new_context_file,
        )
