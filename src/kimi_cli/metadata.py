import json
from hashlib import md5
from pathlib import Path

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
