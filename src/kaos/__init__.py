from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextvars import ContextVar
from pathlib import PurePath
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

if TYPE_CHECKING:
    from kaos.path import KaosPath


type StrOrKaosPath = str | KaosPath


@runtime_checkable
class Kaos(Protocol):
    """Kimi Agent Operating System (KAOS) interface."""

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


current_kaos = ContextVar[Kaos | None]("current_kaos", default=None)


def _get_kaos_or_none() -> Kaos | None:
    return current_kaos.get()


def pathclass() -> type[PurePath]:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return kaos.pathclass()


def gethome() -> KaosPath:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return kaos.gethome()


def getcwd() -> KaosPath:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return kaos.getcwd()


async def chdir(path: StrOrKaosPath) -> None:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    await kaos.chdir(path)


async def stat(path: StrOrKaosPath, *, follow_symlinks: bool = True) -> os.stat_result:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return await kaos.stat(path, follow_symlinks=follow_symlinks)


async def iterdir(path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return kaos.iterdir(path)


async def glob(
    path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
) -> AsyncGenerator[KaosPath]:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return kaos.glob(path, pattern, case_sensitive=case_sensitive)


async def readtext(
    path: StrOrKaosPath,
    *,
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> str:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return await kaos.readtext(path, encoding=encoding, errors=errors)


async def readlines(
    path: StrOrKaosPath,
    *,
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> AsyncGenerator[str]:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return kaos.readlines(path, encoding=encoding, errors=errors)


async def writetext(
    path: StrOrKaosPath,
    data: str,
    *,
    mode: Literal["w", "a"] = "w",
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> int:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return await kaos.writetext(path, data, mode=mode, encoding=encoding, errors=errors)


async def mkdir(path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False) -> None:
    kaos = _get_kaos_or_none()
    if kaos is None:
        raise RuntimeError("No Kaos context is set")
    return await kaos.mkdir(path, parents=parents, exist_ok=exist_ok)
