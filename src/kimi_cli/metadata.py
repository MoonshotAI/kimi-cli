import json
from hashlib import md5
from pathlib import Path
from typing import Any, cast

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


def load_metadata() -> Metadata:
    metadata_file = get_metadata_file()
    logger.debug("Loading metadata from file: {file}", file=metadata_file)
    if not metadata_file.exists():
        logger.debug("No metadata file found, creating empty metadata")
        return Metadata()
    with open(metadata_file, encoding="utf-8") as f:
        data = json.load(f)
        return Metadata(**data)


def save_metadata(metadata: Metadata):
    metadata_file = get_metadata_file()
    logger.debug("Saving metadata to file: {file}", file=metadata_file)
    with open(metadata_file, "w", encoding="utf-8") as f:
        json.dump(metadata.model_dump(), f, indent=2, ensure_ascii=False)


def load_session(work_dir: Path, session_id: str):
    """Load a session by its id and set it to the current session."""
    from kimi_cli.session import Session

    logger.debug(
        "Loading session: {session_id} for work directory: {work_dir}",
        session_id=session_id,
        work_dir=work_dir,
    )

    metadata = load_metadata()
    work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
    if work_dir_meta is None:
        logger.debug("Work directory never been used")
        return None

    history_file = work_dir_meta.sessions_dir / f"{session_id}.jsonl"
    if not history_file.exists():
        logger.warning("Session history file not found: {history_file}", history_file=history_file)
        return None

    work_dir_meta.last_session_id = session_id
    save_metadata(metadata)

    logger.info("Loaded session {session_id} and set as current", session_id=session_id)

    return Session(id=session_id, work_dir=work_dir, history_file=history_file)


def _get_session_info(session_file: Path) -> dict[str, Any]:
    """Get session's meta info from the session file."""
    from datetime import datetime

    info: dict[str, Any] = {
        "timestamp": datetime.fromtimestamp(session_file.stat().st_mtime),
        "num_messages": 0,
        "num_checkpoints": 0,
        "first_message": None,
    }

    try:
        with open(session_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                data = json.loads(line)
                role = data.get("role")

                if role == "_checkpoint":
                    info["num_checkpoints"] += 1
                elif role == "user" or role == "assistant":
                    info["num_messages"] += 1

                    # Use the first message as preview for the session
                    if info["first_message"] is None and role == "user":
                        content = data.get("content")
                        if not content:
                            continue

                        text: str | None = None
                        if isinstance(content, str):
                            text = content
                        elif isinstance(content, list):
                            content_list = cast(list[Any], content)
                            if len(content_list) > 0:
                                first_part = content_list[0]
                                if isinstance(first_part, str):
                                    text = first_part
                                elif isinstance(first_part, dict):
                                    part_dict = cast(dict[str, Any], first_part)
                                    if "text" in part_dict:
                                        text = str(part_dict["text"])

                        if text is None:
                            continue

                        # Skip injected system messages
                        if text.startswith("<system>") and text.endswith("</system>"):
                            continue
                        info["first_message"] = text[:50].strip()
    except Exception as e:
        logger.warning(
            "Failed to get session info from {session_file}: {e}", session_file=session_file, e=e
        )
    return info


def list_sessions(work_dir: Path) -> list[tuple[str, Path, dict[str, Any]]]:
    """List all the latest sessions for a work directory.

    Returns:
        List of tuples (session_id, session_file, info) sorted by timestamp descending.
    """
    logger.debug("Listing sessions for work directory: {work_dir}", work_dir=work_dir)

    metadata = load_metadata()
    work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
    if work_dir_meta is None:
        logger.debug("Work directory never been used")
        return []

    sessions: list[tuple[str, Path, dict[str, Any]]] = []
    sessions_dir = work_dir_meta.sessions_dir

    # Since the revert to checkpoint will create a new session file,
    # we need to list the most up-to-date files and sort them by timestamp.
    for session_file in sessions_dir.glob("*.jsonl"):
        if "_" in session_file.stem:
            logger.debug("Skipping backup file: {session_file}", session_file=session_file)
            continue

        session_id = session_file.stem
        info = _get_session_info(session_file)
        info["is_current"] = session_id == work_dir_meta.last_session_id

        sessions.append((session_id, session_file, info))

    sessions.sort(key=lambda x: x[2]["timestamp"], reverse=True)

    logger.debug("Found {num_sessions} sessions", num_sessions=len(sessions))

    return sessions
