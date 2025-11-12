from __future__ import annotations

import uuid
from pathlib import Path
from typing import NamedTuple

from kimi_cli.metadata import WorkDirMeta, load_metadata, save_metadata
from kimi_cli.utils.logging import logger


class Session(NamedTuple):
    """A session of a work directory."""

    id: str
    work_dir: Path
    history_file: Path

    @staticmethod
    def create(work_dir: Path, _history_file: Path | None = None) -> Session:
        """Create a new session for a work directory."""
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

        save_metadata(metadata)

        return Session(
            id=session_id,
            work_dir=work_dir,
            history_file=history_file,
        )

    @staticmethod
    def continue_(work_dir: Path) -> Session | None:
        """Get the last session for a work directory."""
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

    def mark_as_last(self) -> None:
        """Mark this session as the last completed session for its work directory."""
        metadata = load_metadata()
        work_dir_meta = next(
            (wd for wd in metadata.work_dirs if wd.path == str(self.work_dir)), None
        )

        if work_dir_meta is None:
            logger.warning(
                "Work directory metadata missing when marking last session, recreating: {work_dir}",
                work_dir=self.work_dir,
            )
            work_dir_meta = WorkDirMeta(path=str(self.work_dir))
            metadata.work_dirs.append(work_dir_meta)

        work_dir_meta.last_session_id = self.id
        logger.debug(
            "Updated last session for work directory: {work_dir} -> {session_id}",
            work_dir=self.work_dir,
            session_id=self.id,
        )
        save_metadata(metadata)
