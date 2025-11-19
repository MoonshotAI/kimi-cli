from __future__ import annotations

import os
import posixpath
from collections.abc import AsyncGenerator
from pathlib import Path, PurePosixPath
from stat import S_ISDIR, S_ISREG
from typing import Literal

import kaos


class KaosPath(PurePosixPath):
    """
    A path abstraction for KAOS filesystem.
    """

    @classmethod
    def from_local_path(cls, path: Path) -> KaosPath:
        """Create a KaosPath from a local Path."""
        return cls(str(path.as_posix()))

    def to_local_path(self) -> Path:
        """Convert the KaosPath to a local Path."""
        posix_path = self.as_posix()
        return Path(posix_path.replace("/", os.sep))

    @classmethod
    def home(cls) -> KaosPath:
        """Return the home directory as a KaosPath."""
        return kaos.gethome()

    @classmethod
    def cwd(cls) -> KaosPath:
        """Return the current working directory as a KaosPath."""
        return kaos.getcwd()

    def canonical(self) -> KaosPath:
        """
        Make the path absolute, resolving all `.` and `..` in the path.
        Unlike `pathlib.Path.resolve`, this method does not resolve symlinks.
        """
        # If the path is relative, make it absolute by prepending the current working directory
        if not self.is_absolute():
            abs_path = posixpath.join(kaos.getcwd().as_posix(), self.as_posix())
        else:
            abs_path = self.as_posix()

        # Normalize the path (handle . and ..) but preserve the format
        normalized = posixpath.normpath(abs_path)

        # posixpath.normpath might strip trailing slash, but we want to preserve it for directories
        # However, since we don't access the filesystem, we can't know if it's a directory
        # So we follow the pathlib behavior which doesn't preserve trailing slashes

        return KaosPath(normalized)

    async def stat(self, follow_symlinks: bool = True) -> os.stat_result:
        """Return an os.stat_result for the path."""
        return await kaos.stat(self, follow_symlinks=follow_symlinks)

    async def exists(self, *, follow_symlinks: bool = True) -> bool:
        """Return True if the path points to an existing filesystem entry."""
        try:
            await self.stat(follow_symlinks=follow_symlinks)
            return True
        except OSError:
            return False

    async def is_file(self, *, follow_symlinks: bool = True) -> bool:
        """Return True if the path points to a regular file."""
        try:
            st = await self.stat(follow_symlinks=follow_symlinks)
            return S_ISREG(st.st_mode)
        except OSError:
            return False

    async def is_dir(self, *, follow_symlinks: bool = True) -> bool:
        """Return True if the path points to a directory."""
        try:
            st = await self.stat(follow_symlinks=follow_symlinks)
            return S_ISDIR(st.st_mode)
        except OSError:
            return False

    async def iterdir(self) -> AsyncGenerator[KaosPath]:
        """Return the direct children of the directory."""
        return await kaos.iterdir(self)

    async def glob(self, pattern: str, *, case_sensitive: bool = True) -> AsyncGenerator[KaosPath]:
        """Return all paths matching the pattern under this directory."""
        return await kaos.glob(pattern, case_sensitive=case_sensitive)

    async def read_text(
        self,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        """Read the entire file contents as text."""
        return await kaos.readtext(self, encoding=encoding, errors=errors)

    async def read_lines(
        self,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        """Iterate over the lines of the file."""
        return await kaos.readlines(self, encoding=encoding, errors=errors)

    async def write_text(
        self,
        data: str,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        """Write text data to the file, returning the number of characters written."""
        return await kaos.writetext(
            self,
            data,
            mode="w",
            encoding=encoding,
            errors=errors,
        )

    async def append_text(
        self,
        data: str,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        """Append text data to the file, returning the number of characters written."""
        return await kaos.writetext(
            self,
            data,
            mode="a",
            encoding=encoding,
            errors=errors,
        )
