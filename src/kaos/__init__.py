from __future__ import annotations

import contextvars
import os
from collections.abc import AsyncGenerator
from pathlib import PurePath
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

if TYPE_CHECKING:
    from kaos.path import KaosPath


type StrOrKaosPath = str | KaosPath


@runtime_checkable
class Kaos(Protocol):
    """Kimi Agent Operating System (KAOS) interface."""

    name: str
    """The name of the KAOS implementation."""

    def pathclass(self) -> type[PurePath]:
        """Get the path class used under `KaosPath`."""
        ...

    def gethome(self) -> KaosPath:
        """Get the home directory path."""
        ...

    def getcwd(self) -> KaosPath:
        """Get the current working directory path."""
        ...

    async def chdir(self, path: StrOrKaosPath) -> None:
        """Change the current working directory."""
        ...

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> os.stat_result:
        """Get the stat result for a path."""
        ...

    def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        """Iterate over the entries in a directory."""
        ...

    def glob(
        self, path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
    ) -> AsyncGenerator[KaosPath]:
        """Search for files/directories matching a pattern in the given path."""
        ...

    async def readtext(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        """Read the entire file contents as text."""
        ...

    def readlines(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        """Iterate over the lines of the file."""
        ...

    async def writetext(
        self,
        path: StrOrKaosPath,
        data: str,
        *,
        mode: Literal["w", "a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        """Write text data to the file, returning the number of characters written."""
        ...

    async def mkdir(
        self, path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False
    ) -> None:
        """Create a directory at the given path."""
        ...


def get_current_kaos() -> Kaos:
    """Get the current KAOS instance."""
    from kaos._current import current_kaos

    return current_kaos.get()


def set_current_kaos(kaos: Kaos) -> contextvars.Token[Kaos]:
    """Set the current KAOS instance."""
    from kaos._current import current_kaos

    return current_kaos.set(kaos)


def reset_current_kaos(token: contextvars.Token[Kaos]) -> None:
    """Reset the current KAOS instance."""
    from kaos._current import current_kaos

    current_kaos.reset(token)


def pathclass() -> type[PurePath]:
    return get_current_kaos().pathclass()


def gethome() -> KaosPath:
    return get_current_kaos().gethome()


def getcwd() -> KaosPath:
    return get_current_kaos().getcwd()


async def chdir(path: StrOrKaosPath) -> None:
    await get_current_kaos().chdir(path)


async def stat(path: StrOrKaosPath, *, follow_symlinks: bool = True) -> os.stat_result:
    return await get_current_kaos().stat(path, follow_symlinks=follow_symlinks)


async def iterdir(path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
    return get_current_kaos().iterdir(path)


async def glob(
    path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
) -> AsyncGenerator[KaosPath]:
    return get_current_kaos().glob(path, pattern, case_sensitive=case_sensitive)


async def readtext(
    path: StrOrKaosPath,
    *,
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> str:
    return await get_current_kaos().readtext(path, encoding=encoding, errors=errors)


async def readlines(
    path: StrOrKaosPath,
    *,
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> AsyncGenerator[str]:
    return get_current_kaos().readlines(path, encoding=encoding, errors=errors)


async def writetext(
    path: StrOrKaosPath,
    data: str,
    *,
    mode: Literal["w", "a"] = "w",
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> int:
    return await get_current_kaos().writetext(
        path, data, mode=mode, encoding=encoding, errors=errors
    )


async def mkdir(path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False) -> None:
    return await get_current_kaos().mkdir(path, parents=parents, exist_ok=exist_ok)
