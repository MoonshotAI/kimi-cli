from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from pathlib import Path, PurePath
from typing import TYPE_CHECKING, Literal

if os.name == "nt":
    from pathlib import PureWindowsPath
else:
    from pathlib import PurePosixPath

import aiofiles
import aiofiles.os
import aiopath

from kaos import Kaos, StrOrKaosPath
from kaos.path import KaosPath

if TYPE_CHECKING:

    def type_check(local: LocalKaos) -> None:
        _: Kaos = local


class LocalKaos:
    """
    A KAOS implementation that directly interacts with the local filesystem.
    """

    def pathclass(self) -> type[PurePath]:
        return PureWindowsPath if os.name == "nt" else PurePosixPath

    def gethome(self) -> KaosPath:
        return KaosPath.unsafe_from_local_path(Path.home())

    def getcwd(self) -> KaosPath:
        return KaosPath.unsafe_from_local_path(Path.cwd())

    async def chdir(self, path: StrOrKaosPath) -> None:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        os.chdir(local_path)

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> os.stat_result:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        return await aiofiles.os.stat(local_path, follow_symlinks=follow_symlinks)

    async def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        for entry in await aiofiles.os.listdir(local_path):
            yield KaosPath.unsafe_from_local_path(local_path / entry)

    async def glob(
        self, path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
    ) -> AsyncGenerator[KaosPath]:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async_local_path = aiopath.AsyncPath(local_path)
        async for entry in async_local_path.glob(pattern, case_sensitive=case_sensitive):
            yield KaosPath.unsafe_from_local_path(entry)

    async def readtext(
        self,
        path: str | KaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async with aiofiles.open(local_path, encoding=encoding, errors=errors) as f:
            return await f.read()

    async def readlines(
        self,
        path: str | KaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async with aiofiles.open(local_path, encoding=encoding, errors=errors) as f:
            async for line in f:
                yield line

    async def writetext(
        self,
        path: str | KaosPath,
        data: str,
        *,
        mode: Literal["w"] | Literal["a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async with aiofiles.open(local_path, mode=mode, encoding=encoding, errors=errors) as f:
            return await f.write(data)

    async def mkdir(
        self, path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False
    ) -> None:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async_local_path = aiopath.AsyncPath(local_path)
        await async_local_path.mkdir(parents=parents, exist_ok=exist_ok)
