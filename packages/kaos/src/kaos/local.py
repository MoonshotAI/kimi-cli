from __future__ import annotations

import asyncio
import os
from asyncio.subprocess import Process as AsyncioProcess
from collections.abc import AsyncGenerator
from pathlib import Path, PurePath
from typing import TYPE_CHECKING, Literal

if os.name == "nt":
    import ntpath as pathmodule
    from pathlib import PureWindowsPath as PurePathClass
else:
    import posixpath as pathmodule
    from pathlib import PurePosixPath as PurePathClass

import aiofiles
import aiofiles.os

from kaos import AsyncReadable, AsyncWritable, Kaos, KaosProcess, StatResult, StrOrKaosPath
from kaos.path import KaosPath

if TYPE_CHECKING:

    def type_check(local: LocalKaos) -> None:
        _: Kaos = local


class LocalKaos:
    """
    A KAOS implementation that directly interacts with the local filesystem.
    """

    name: str = "local"

    class Process:
        """Local KAOS process wrapper around asyncio.subprocess.Process."""

        def __init__(self, process: AsyncioProcess) -> None:
            if process.stdin is None or process.stdout is None or process.stderr is None:
                raise ValueError("Process must be created with stdin/stdout/stderr pipes.")

            self._process = process
            self.stdin: AsyncWritable = process.stdin
            self.stdout: AsyncReadable = process.stdout
            self.stderr: AsyncReadable = process.stderr

        @property
        def pid(self) -> int:
            return self._process.pid

        @property
        def returncode(self) -> int | None:
            return self._process.returncode

        async def wait(self) -> int:
            return await self._process.wait()

        async def kill(self) -> None:
            self._process.kill()

    def pathclass(self) -> type[PurePath]:
        return PurePathClass

    def normpath(self, path: StrOrKaosPath) -> KaosPath:
        return KaosPath(pathmodule.normpath(str(path)))

    def gethome(self) -> KaosPath:
        return KaosPath.unsafe_from_local_path(Path.home())

    def getcwd(self) -> KaosPath:
        return KaosPath.unsafe_from_local_path(Path.cwd())

    async def chdir(self, path: StrOrKaosPath) -> None:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        os.chdir(local_path)

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        st = await aiofiles.os.stat(local_path, follow_symlinks=follow_symlinks)
        return StatResult(
            st_mode=st.st_mode,
            st_ino=st.st_ino,
            st_dev=st.st_dev,
            st_nlink=st.st_nlink,
            st_uid=st.st_uid,
            st_gid=st.st_gid,
            st_size=st.st_size,
            st_atime=st.st_atime,
            st_mtime=st.st_mtime,
            st_ctime=st.st_ctime if os.name != "nt" else st.st_birthtime,
        )

    async def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        for entry in await aiofiles.os.listdir(local_path):
            yield KaosPath.unsafe_from_local_path(local_path / entry)

    async def glob(
        self, path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
    ) -> AsyncGenerator[KaosPath]:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        entries = await asyncio.to_thread(
            lambda: list(local_path.glob(pattern, case_sensitive=case_sensitive))
        )
        for entry in entries:
            yield KaosPath.unsafe_from_local_path(entry)

    async def readbytes(self, path: StrOrKaosPath) -> bytes:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async with aiofiles.open(local_path, mode="rb") as f:
            return await f.read()

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

    async def writebytes(self, path: StrOrKaosPath, data: bytes) -> int:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async with aiofiles.open(local_path, mode="wb") as f:
            return await f.write(data)

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
        await asyncio.to_thread(local_path.mkdir, parents=parents, exist_ok=exist_ok)

    async def exec(self, *args: str) -> KaosProcess:
        if not args:
            raise ValueError("At least one argument (the program to execute) is required.")

        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return self.Process(process)


local_kaos = LocalKaos()
"""The default local KAOS instance."""
