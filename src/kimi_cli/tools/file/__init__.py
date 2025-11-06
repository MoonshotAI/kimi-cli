from enum import Enum
from pathlib import Path


class FileOpsWindow:
    """Track file operations within a session for safety checks."""

    def __init__(self) -> None:
        self._read_files: set[str] = set()

    @staticmethod
    def _normalize(path: Path) -> str:
        """Normalize paths for tracking."""
        try:
            return str(path.resolve())
        except FileNotFoundError:
            # Fallback to absolute path when resolving fails (e.g. deleted file)
            return str(path.absolute())

    def mark_read(self, path: Path) -> None:
        """Record that a file has been read in the current session."""
        self._read_files.add(self._normalize(path))

    def has_read(self, path: Path) -> bool:
        """Check if the file has been read previously in the session."""
        return self._normalize(path) in self._read_files


class FileActions(str, Enum):
    READ = "read file"
    EDIT = "edit file"


from .glob import Glob  # noqa: E402
from .grep import Grep  # noqa: E402
from .patch import PatchFile  # noqa: E402
from .read import ReadFile  # noqa: E402
from .replace import StrReplaceFile  # noqa: E402
from .write import WriteFile  # noqa: E402

__all__ = (
    "ReadFile",
    "Glob",
    "Grep",
    "WriteFile",
    "StrReplaceFile",
    "PatchFile",
)
