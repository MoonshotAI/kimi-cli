from enum import StrEnum


class FileOpsWindow:
    """Maintains a window of file operations."""

    pass


class FileActions(StrEnum):
    READ = "read file"
    EDIT = "edit file"
    EDIT_OUTSIDE = "edit file outside of working directory"


from .glob import Glob  # noqa: E402
from .grep_local import Grep  # noqa: E402
from .read import ReadFile  # noqa: E402
from .read_media import ReadMediaFile  # noqa: E402
from .replace import StrReplaceFile  # noqa: E402
from .write import WriteFile  # noqa: E402

__all__ = (
    "ReadFile",
    "ReadMediaFile",
    "Glob",
    "Grep",
    "WriteFile",
    "StrReplaceFile",
)
