import json
import uuid
from hashlib import md5
from pathlib import Path
from typing import NamedTuple

from pydantic import BaseModel, Field

from kimi_cli.share import get_share_dir
from kimi_cli.utils.logging import logger


def get_metadata_file() -> Path:
    return get_share_dir() / "kimi.json"


class WorkDirMeta(BaseModel):
    """Metadata for a work directory."""

    path: str
    """The full path of the work directory."""

    last_session_id: str | None = None
    """Last session ID of this work directory."""

    @property
    def sessions_dir(self) -> Path:
        path = get_share_dir() / "sessions" / md5(self.path.encode()).hexdigest()
        path.mkdir(parents=True, exist_ok=True)
        return path


class Metadata(BaseModel):
    """Kimi metadata structure."""

    work_dirs: list[WorkDirMeta] = Field(
        default_factory=list[WorkDirMeta], description="Work directory list"
    )


def _load_metadata() -> Metadata:
    metadata_file = get_metadata_file()
    logger.debug("Loading metadata from file: {file}", file=metadata_file)
    if not metadata_file.exists():
        logger.debug("No metadata file found, creating empty metadata")
        return Metadata()
    with open(metadata_file, encoding="utf-8") as f:
        data = json.load(f)
        return Metadata(**data)


def _save_metadata(metadata: Metadata):
    metadata_file = get_metadata_file()
    logger.debug("Saving metadata to file: {file}", file=metadata_file)
    with open(metadata_file, "w", encoding="utf-8") as f:
        json.dump(metadata.model_dump(), f, indent=2, ensure_ascii=False)


class Session(NamedTuple):
    """A session of a work directory."""

    id: str
    work_dir: WorkDirMeta
    history_file: Path


def new_session(work_dir: Path, _history_file: Path | None = None) -> Session:
    """Create a new session for a work directory."""
    logger.debug("Creating new session for work directory: {work_dir}", work_dir=work_dir)

    metadata = _load_metadata()
    work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
    if work_dir_meta is None:
        work_dir_meta = WorkDirMeta(path=str(work_dir))
        metadata.work_dirs.append(work_dir_meta)

    session_id = str(uuid.uuid4())
    if _history_file is None:
        history_file = work_dir_meta.sessions_dir / f"{session_id}.jsonl"
        work_dir_meta.last_session_id = session_id
    else:
        logger.warning("Using provided history file: {history_file}", history_file=_history_file)
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

    _save_metadata(metadata)
    return Session(id=session_id, work_dir=work_dir_meta, history_file=history_file)


def continue_session(work_dir: Path) -> Session | None:
    """Get the last session for a work directory."""
    logger.debug("Continuing session for work directory: {work_dir}", work_dir=work_dir)

    metadata = _load_metadata()
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
    return Session(id=session_id, work_dir=work_dir_meta, history_file=history_file)
