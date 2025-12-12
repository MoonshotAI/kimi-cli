from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

from kaos.path import KaosPath

from kimi_cli.metadata import WorkDirMeta, load_metadata, save_metadata
from kimi_cli.share import get_share_dir
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

        # Update session-to-workdir mapping
        metadata.session_to_workdir[session_id] = str(work_dir)
        save_metadata(metadata)

        return Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
            title=session_id,  # TODO: readable session titles
            updated_at=context_file.stat().st_mtime,
        )

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

        return Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
            title=session_id,  # TODO: readable session titles
            updated_at=context_file.stat().st_mtime,
        )

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
        for session_id in sorted(session_ids):
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
            sessions.append(
                Session(
                    id=session_id,
                    work_dir=work_dir,
                    work_dir_meta=work_dir_meta,
                    context_file=context_file,
                    title=session_id,  # TODO: readable session titles
                    updated_at=context_file.stat().st_mtime,
                )
            )
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
        session_id = work_dir_meta.last_session_id
        _migrate_session_context_file(work_dir_meta, session_id)

        session_dir = work_dir_meta.sessions_dir / session_id
        context_file = session_dir / "context.jsonl"
        if not context_file.exists():
            logger.debug(
                "Session context file not found: {context_file}", context_file=context_file
            )
            return None

        return Session(
            id=session_id,
            work_dir=work_dir,
            work_dir_meta=work_dir_meta,
            context_file=context_file,
            title=session_id,  # TODO: readable session titles
            updated_at=context_file.stat().st_mtime,
        )

    @staticmethod
    def load_by_id(session_id: str) -> Session | None:
        """Load a session by its ID, regardless of work directory.

        Args:
            session_id: The UUID of the session to load.

        Returns:
            Session instance if found, None otherwise.
        """
        logger.debug("Loading session by ID: {session_id}", session_id=session_id)

        metadata = load_metadata()

        # Try metadata lookup first (fast path)
        work_dir_str = metadata.session_to_workdir.get(session_id)
        if work_dir_str:
            work_dir = KaosPath.unsafe_from_local_path(Path(work_dir_str))
            work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == work_dir_str), None)
            if work_dir_meta:
                # Migrate session context file if needed (for backward compatibility)
                _migrate_session_context_file(work_dir_meta, session_id)
                # Create the session directory and context file path
                session_dir = work_dir_meta.sessions_dir / session_id
                context_file = session_dir / "context.jsonl"
                if context_file.exists():
                    logger.debug(
                        "Found session in metadata: {session_id} -> {work_dir}",
                        session_id=session_id,
                        work_dir=work_dir,
                    )
                    return Session(
                        id=session_id,
                        work_dir=work_dir,
                        work_dir_meta=work_dir_meta,
                        context_file=context_file,
                    )
                else:
                    logger.debug(
                        "Session found in metadata but context file missing: {context_file}",
                        context_file=context_file,
                    )

        # Fallback: scan filesystem for backward compatibility
        # This handles cases where metadata might be missing (e.g., old sessions)
        logger.debug("Session not found in metadata, scanning filesystem")
        sessions_base_dir = get_share_dir() / "sessions"
        if sessions_base_dir.exists():
            for work_dir_hash_dir in sessions_base_dir.iterdir():
                if not work_dir_hash_dir.is_dir():
                    continue
                session_dir = work_dir_hash_dir / session_id
                context_file = session_dir / "context.jsonl"
                if context_file.exists():
                    # Found the session file, now find the work directory
                    # We need to find which work_dir_meta has this sessions_dir
                    for work_dir_meta in metadata.work_dirs:
                        if work_dir_meta.sessions_dir == work_dir_hash_dir:
                            # Migrate session context file if needed (for backward compatibility)
                            _migrate_session_context_file(work_dir_meta, session_id)
                            # Re-check context file path after migration
                            context_file = work_dir_meta.sessions_dir / session_id / "context.jsonl"
                            if not context_file.exists():
                                continue
                            work_dir = KaosPath.unsafe_from_local_path(Path(work_dir_meta.path))
                            logger.debug(
                                "Found session in filesystem: {session_id} -> {work_dir}",
                                session_id=session_id,
                                work_dir=work_dir,
                            )
                            # Update metadata for future lookups
                            metadata.session_to_workdir[session_id] = str(work_dir)
                            save_metadata(metadata)
                            return Session(
                                id=session_id,
                                work_dir=work_dir,
                                work_dir_meta=work_dir_meta,
                                context_file=context_file,
                            )

        logger.debug("Session not found: {session_id}", session_id=session_id)
        return None


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
