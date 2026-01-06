from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path, PurePath
from stat import S_ISDIR, S_ISREG
from typing import Any, Literal

import kaos


class KaosPath:
    """
    A path abstraction for KAOS filesystem.
    """

    def __init__(self, *args: str) -> None:
        self._path: PurePath = kaos.pathclass()(*args)

    @classmethod
    def unsafe_from_local_path(cls, path: Path) -> KaosPath:
        """
        Create a `KaosPath` from a local `Path`.
        Only use this if you are sure that `LocalKaos` is being used.
        """
        return cls(str(path))

    def unsafe_to_local_path(self) -> Path:
        """
        Convert the `KaosPath` to a local `Path`.
        Only use this if you are sure that `LocalKaos` is being used.
        """
        return Path(str(self._path))

    def __lt__(self, other: KaosPath) -> bool:
        return self._path.__lt__(other._path)

    def __le__(self, other: KaosPath) -> bool:
        return self._path.__le__(other._path)

    def __gt__(self, other: KaosPath) -> bool:
        return self._path.__gt__(other._path)

    def __ge__(self, other: KaosPath) -> bool:
        return self._path.__ge__(other._path)

    def __eq__(self, other: Any) -> bool:
        if not isinstance(other, KaosPath):
            return NotImplemented
        return self._path.__eq__(other._path)

    def __repr__(self) -> str:
        return f"KaosPath({repr(str(self._path))})"

    def __str__(self) -> str:
        return str(self._path)

    @property
    def name(self) -> str:
        """Return the final component of the path."""
        return self._path.name

    @property
    def parent(self) -> KaosPath:
        """Return the parent directory of the path."""
        return KaosPath(str(self._path.parent))

    def is_absolute(self) -> bool:
        """Return True if the path is absolute."""
        return self._path.is_absolute()

    def joinpath(self, *other: str) -> KaosPath:
        """Join this path with other path components."""
        return KaosPath(str(self._path.joinpath(*other)))

    def __truediv__(self, other: str | KaosPath) -> KaosPath:
        """Join this path with another path using the `/` operator."""
        p = other._path if isinstance(other, KaosPath) else other
        ret = KaosPath()
        ret._path = self._path.__truediv__(p)
        return ret

    def canonical(self) -> KaosPath:
        """
        Make the path absolute, resolving all `.` and `..` in the path.
        Unlike `pathlib.Path.resolve`, this method does not resolve symlinks.
        """
        abs_path = self if self.is_absolute() else kaos.getcwd().joinpath(str(self._path))
        # Normalize the path (handle . and ..) but preserve the format
        normalized = kaos.normpath(abs_path)
        # `normpath` might strip trailing slash, but we want to preserve it for directories
        # However, since we don't access the filesystem, we can't know if it's a directory
        # So we follow the pathlib behavior which doesn't preserve trailing slashes
        return normalized

    def relative_to(self, other: KaosPath) -> KaosPath:
        """Return the relative path from `other` to this path."""
        relative_path = self._path.relative_to(other._path)
        return KaosPath(str(relative_path))

    @classmethod
    def home(cls) -> KaosPath:
        """Return the home directory as a KaosPath."""
        return kaos.gethome()

    @classmethod
    def cwd(cls) -> KaosPath:
        """Return the current working directory as a KaosPath."""
        return kaos.getcwd()

    def expanduser(self) -> KaosPath:
        """Expand `~` to the backend home directory."""
        parts = self._path.parts
        if not parts or parts[0] != "~":
            return self

        home = KaosPath.home()
        if len(parts) == 1:
            return home
        return home.joinpath(*parts[1:])

    async def stat(self, follow_symlinks: bool = True) -> kaos.StatResult:
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

    def iterdir(self) -> AsyncGenerator[KaosPath]:
        """Return the direct children of the directory."""
        return kaos.iterdir(self)

    def glob(self, pattern: str, *, case_sensitive: bool = True) -> AsyncGenerator[KaosPath]:
        """Return all paths matching the pattern under this directory."""
        return kaos.glob(self, pattern, case_sensitive=case_sensitive)

    async def read_bytes(self) -> bytes:
        """Read the entire file contents as bytes."""
        return await kaos.readbytes(self)

    async def read_text(
        self,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        """Read the entire file contents as text."""
        return await kaos.readtext(self, encoding=encoding, errors=errors)

    def read_lines(
        self,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        """Iterate over the lines of the file."""
        return kaos.readlines(self, encoding=encoding, errors=errors)

    async def write_bytes(self, data: bytes) -> int:
        """Write bytes data to the file."""
        return await kaos.writebytes(self, data)

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

    async def mkdir(self, parents: bool = False, exist_ok: bool = False) -> None:
        """Create a directory at this path."""
        return await kaos.mkdir(self, parents=parents, exist_ok=exist_ok)
