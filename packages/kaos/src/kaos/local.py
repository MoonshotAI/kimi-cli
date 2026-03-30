from __future__ import annotations

import asyncio
import os
from asyncio.subprocess import Process as AsyncioProcess
from collections.abc import AsyncGenerator
from pathlib import Path, PurePath
from stat import S_ISDIR
from typing import TYPE_CHECKING, Literal

if os.name == "nt":
    import ntpath as pathmodule
    from pathlib import PureWindowsPath as PurePathClass
else:
    import posixpath as pathmodule
    from pathlib import PurePosixPath as PurePathClass

from collections.abc import Mapping

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

    async def readbytes(self, path: StrOrKaosPath, n: int | None = None) -> bytes:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        async with aiofiles.open(local_path, mode="rb") as f:
            return await f.read() if n is None else await f.read(n)

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
        async with aiofiles.open(
            local_path, mode=mode, encoding=encoding, errors=errors, newline=""
        ) as f:
            return await f.write(data)

    async def mkdir(
        self, path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False
    ) -> None:
        local_path = path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)
        await asyncio.to_thread(local_path.mkdir, parents=parents, exist_ok=exist_ok)

    async def exec(self, *args: str, env: Mapping[str, str] | None = None) -> KaosProcess:
        if not args:
            raise ValueError("At least one argument (the program to execute) is required.")

        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        return self.Process(process)


class ScopedLocalKaos(LocalKaos):
    """Local KAOS backend with an instance-local working directory."""

    def __init__(self, cwd: StrOrKaosPath | None = None) -> None:
        base_cwd = Path.cwd()
        self._cwd = self._normalize_local_path(
            self._coerce_local_path(cwd) if cwd is not None else base_cwd,
            base=base_cwd,
        )

    @staticmethod
    def _coerce_local_path(path: StrOrKaosPath) -> Path:
        return path.unsafe_to_local_path() if isinstance(path, KaosPath) else Path(path)

    def _normalize_local_path(self, path: Path, *, base: Path | None = None) -> Path:
        if not path.is_absolute():
            path = (base or self._cwd) / path
        return Path(pathmodule.normpath(str(path)))

    def _resolve_local_path(self, path: StrOrKaosPath) -> Path:
        return self._normalize_local_path(self._coerce_local_path(path))

    def _resolve_kaos_path(self, path: StrOrKaosPath) -> KaosPath:
        return KaosPath.unsafe_from_local_path(self._resolve_local_path(path))

    def getcwd(self) -> KaosPath:
        return KaosPath.unsafe_from_local_path(self._cwd)

    async def chdir(self, path: StrOrKaosPath) -> None:
        local_path = self._resolve_local_path(path)
        st = await aiofiles.os.stat(local_path)
        if not S_ISDIR(st.st_mode):
            raise NotADirectoryError(str(local_path))
        self._cwd = local_path

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
        return await super().stat(self._resolve_kaos_path(path), follow_symlinks=follow_symlinks)

    async def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        async for entry in super().iterdir(self._resolve_kaos_path(path)):
            yield entry

    async def glob(
        self, path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
    ) -> AsyncGenerator[KaosPath]:
        async for entry in super().glob(
            self._resolve_kaos_path(path),
            pattern,
            case_sensitive=case_sensitive,
        ):
            yield entry

    async def readbytes(self, path: StrOrKaosPath, n: int | None = None) -> bytes:
        return await super().readbytes(self._resolve_kaos_path(path), n=n)

    async def readtext(
        self,
        path: str | KaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        return await super().readtext(
            self._resolve_kaos_path(path),
            encoding=encoding,
            errors=errors,
        )

    async def readlines(
        self,
        path: str | KaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        async for line in super().readlines(
            self._resolve_kaos_path(path),
            encoding=encoding,
            errors=errors,
        ):
            yield line

    async def writebytes(self, path: StrOrKaosPath, data: bytes) -> int:
        return await super().writebytes(self._resolve_kaos_path(path), data)

    async def writetext(
        self,
        path: str | KaosPath,
        data: str,
        *,
        mode: Literal["w"] | Literal["a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        return await super().writetext(
            self._resolve_kaos_path(path),
            data,
            mode=mode,
            encoding=encoding,
            errors=errors,
        )

    async def mkdir(
        self, path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False
    ) -> None:
        await super().mkdir(self._resolve_kaos_path(path), parents=parents, exist_ok=exist_ok)

    async def exec(self, *args: str, env: Mapping[str, str] | None = None) -> KaosProcess:
        if not args:
            raise ValueError("At least one argument (the program to execute) is required.")

        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self._cwd),
            env=env,
        )
        return self.Process(process)


local_kaos = LocalKaos()
"""The default local KAOS instance."""
