from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from pathlib import Path, PurePosixPath
from typing import Literal


class KaosPath(PurePosixPath):
    """
    A path abstraction for KAOS filesystem.
    """

    def __init__(self, path_str: str) -> None:
        super().__init__(path_str)

    @classmethod
    def from_local_path(cls, path: Path) -> KaosPath:
        """Create a KaosPath from a local Path."""
        raise NotImplementedError

    @classmethod
    def home(cls) -> KaosPath:
        """Return the home directory as a KaosPath."""
        raise NotImplementedError

    @classmethod
    def cwd(cls) -> KaosPath:
        """Return the current working directory as a KaosPath."""
        raise NotImplementedError

    async def resolve(self) -> KaosPath:
        """Make the path absolute, resolving all symlinks on the way and also normalizing it."""
        raise NotImplementedError

    async def exists(self) -> bool:
        """Return True if the path points to an existing filesystem entry."""
        raise NotImplementedError

    async def is_file(self) -> bool:
        """Return True if the path points to a regular file."""
        raise NotImplementedError

    async def is_dir(self) -> bool:
        """Return True if the path points to a directory."""
        raise NotImplementedError

    async def iterdir(self) -> AsyncGenerator[KaosPath]:
        """Return the direct children of the directory."""
        raise NotImplementedError

    async def glob(self, pattern: str) -> AsyncGenerator[KaosPath]:
        """Return all paths matching the pattern under this directory."""
        raise NotImplementedError

    async def read_text(
        self,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        """Read the entire file contents as text."""
        raise NotImplementedError

    async def read_lines(
        self,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        """Asynchronously iterate over the lines of the file."""
        raise NotImplementedError

    async def write_text(
        self,
        data: str,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        """Write text data to the file, returning the number of characters written."""
        raise NotImplementedError

    async def append_text(
        self,
        data: str,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        """Append text data to the file, returning the number of characters written."""
        raise NotImplementedError

    async def stat(self, follow_symlinks: bool = True) -> os.stat_result:
        """Return an os.stat_result for the path."""
        raise NotImplementedError
