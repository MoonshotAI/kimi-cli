from enum import Enum


class FileOpsWindow:
    """Maintains a window of file operations."""

    pass


class FileActions(str, Enum):
    READ = "read file"
    EDIT = "edit file"
    EDIT_OUTSIDE = "edit file outside of working directory"


from .glob import Glob  # noqa: E402
from .grep_local import Grep  # noqa: E402
from .read import ReadFile  # noqa: E402
from .replace import StrReplaceFile  # noqa: E402
from .write import WriteFile  # noqa: E402

__all__ = (
    "ReadFile",
    "Glob",
    "Grep",
    "WriteFile",
    "StrReplaceFile",
)
