from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path as OSPath
from pathlib import PurePosixPath


class KaosPath(PurePosixPath):
    """Normalized workspace path handle with async helpers."""

    @classmethod
    def from_os_path(cls, path: OSPath) -> KaosPath:
        """Create a KaosPath from a regular pathlib.Path."""
        return cls(path.as_posix())

    def to_os_path(self) -> OSPath:
        """Convert this KaosPath to a system-dependent Path."""
        return OSPath(self)

    async def exists(self) -> bool:
        """Return True if the path points to an existing filesystem entry."""
        raise NotImplementedError

    async def is_file(self) -> bool:
        """Return True if the path points to a regular file."""
        raise NotImplementedError

    async def is_dir(self) -> bool:
        """Return True if the path points to a directory."""
        raise NotImplementedError

    async def iterdir(self) -> Sequence[KaosPath]:
        """Return the direct children of the directory."""
        raise NotImplementedError

    async def glob(self, pattern: str) -> Sequence[KaosPath]:
        """Return all paths matching the pattern under this directory."""
        raise NotImplementedError

    async def read_text(
        self,
        *,
        encoding: str = "utf-8",
        errors: str | None = None,
    ) -> str:
        """Read the entire file contents as text."""
        raise NotImplementedError

    async def stat(self, follow_symlinks: bool = True) -> os.stat_result:
        """Return an os.stat_result for the path."""
        raise NotImplementedError
