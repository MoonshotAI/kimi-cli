from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

from kaos.path import KaosPath

from kimi_cli.metadata import WorkDirMeta, load_metadata, save_metadata
from kimi_cli.utils.logging import logger


@dataclass(frozen=True, slots=True, kw_only=True)
class Session:
    """A session of a work directory."""

    id: str
    """The session ID."""
    work_dir: KaosPath
    """The absolute path of the work directory."""
    work_dir_meta: WorkDirMeta
    """The metadata of the work directory."""
    context_file: Path
    """The absolute path to the file storing the message history."""

    @property
    def dir(self) -> Path:
        """The absolute path of the session directory."""
        path = self.work_dir_meta.sessions_dir / self.id
        path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    async def create(work_dir: KaosPath, _context_file: Path | None = None) -> Session:
        """Create a new session for a work directory."""
        work_dir = work_dir.canonical()
        logger.debug("Creating new session for work directory: {work_dir}", work_dir=work_dir)

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        if work_dir_meta is None:
            work_dir_meta = metadata.new_work_dir_meta(work_dir)

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

        return Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
        )

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
        session_id = work_dir_meta.last_session_id
        _migrate_session_context_file(work_dir_meta, session_id)

        session_dir = work_dir_meta.sessions_dir / session_id
        context_file = session_dir / "context.jsonl"

        return Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
        )


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
