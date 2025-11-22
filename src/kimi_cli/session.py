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
    history_file: Path
    """The absolute path to the file storing the message history."""

    @staticmethod
    async def create(work_dir: KaosPath, _history_file: Path | None = None) -> Session:
        """Create a new session for a work directory."""
        work_dir = work_dir.canonical()
        logger.debug("Creating new session for work directory: {work_dir}", work_dir=work_dir)

        metadata = load_metadata()
        work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
        if work_dir_meta is None:
            work_dir_meta = WorkDirMeta(path=str(work_dir))
            metadata.work_dirs.append(work_dir_meta)

        session_id = str(uuid.uuid4())
        if _history_file is None:
            history_file = work_dir_meta.sessions_dir / f"{session_id}.jsonl"
        else:
            logger.warning(
                "Using provided history file: {history_file}", history_file=_history_file
            )
            _history_file.parent.mkdir(parents=True, exist_ok=True)
            if _history_file.exists():
                assert _history_file.is_file()
            history_file = _history_file

        if history_file.exists():
            # truncate if exists
            logger.warning(
                "History file already exists, truncating: {history_file}", history_file=history_file
            )
            history_file.unlink()
            history_file.touch()

        # Update session-to-workdir mapping
        metadata.session_to_workdir[session_id] = str(work_dir)
        save_metadata(metadata)

        return Session(
            id=session_id,
            work_dir=work_dir,
            history_file=history_file,
        )

    @staticmethod
    async def continue_(work_dir: KaosPath) -> Session | None:
        """Get the last session for a work directory."""
        work_dir = work_dir.canonical()
        logger.debug("Continuing session for work directory: {work_dir}", work_dir=work_dir)

        metadata = load_metadata()
        work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
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
        history_file = work_dir_meta.sessions_dir / f"{session_id}.jsonl"

        return Session(
            id=session_id,
            work_dir=work_dir,
            history_file=history_file,
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
            work_dir_meta = next(
                (wd for wd in metadata.work_dirs if wd.path == work_dir_str), None
            )
            if work_dir_meta:
                history_file = work_dir_meta.sessions_dir / f"{session_id}.jsonl"
                if history_file.exists():
                    logger.debug(
                        "Found session in metadata: {session_id} -> {work_dir}",
                        session_id=session_id,
                        work_dir=work_dir,
                    )
                    return Session(
                        id=session_id,
                        work_dir=work_dir,
                        history_file=history_file,
                    )
                else:
                    logger.debug(
                        "Session found in metadata but history file missing: {history_file}",
                        history_file=history_file,
                    )

        # Fallback: scan filesystem for backward compatibility
        # This handles cases where metadata might be missing (e.g., old sessions)
        logger.debug("Session not found in metadata, scanning filesystem")
        sessions_base_dir = get_share_dir() / "sessions"
        if sessions_base_dir.exists():
            for work_dir_hash_dir in sessions_base_dir.iterdir():
                if not work_dir_hash_dir.is_dir():
                    continue
                history_file = work_dir_hash_dir / f"{session_id}.jsonl"
                if history_file.exists():
                    # Found the session file, now find the work directory
                    # We need to find which work_dir_meta has this sessions_dir
                    for work_dir_meta in metadata.work_dirs:
                        if work_dir_meta.sessions_dir == work_dir_hash_dir:
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
                                history_file=history_file,
                            )

        logger.debug("Session not found: {session_id}", session_id=session_id)
        return None
