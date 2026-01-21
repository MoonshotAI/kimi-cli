from __future__ import annotations

import asyncio
import posixpath
import shlex
import stat
from collections.abc import AsyncGenerator, Iterable
from datetime import datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Literal

from e2b import (  # type: ignore[import-untyped]
    AsyncCommandHandle,
    AsyncSandbox,
    CommandExitException,
    CommandResult,
    EntryInfo,
    FileType,
    NotFoundException,
)
from e2b.sandbox_async.commands.command import Commands  # type: ignore[import-untyped]

from kaos import AsyncReadable, AsyncWritable, Kaos, KaosProcess, StatResult, StrOrKaosPath
from kaos.path import KaosPath

if TYPE_CHECKING:

    def type_check(e2b_kaos: E2BKaos) -> None:
        _: Kaos = e2b_kaos


class _E2BStdin:
    def __init__(self, commands: Commands, pid: int) -> None:
        self._commands = commands
        self._pid = pid
        self._closed = False
        self._eof_sent = False
        self._lock = asyncio.Lock()
        self._last_task: asyncio.Task[None] | None = None

    def can_write_eof(self) -> bool:
        return False

    def close(self) -> None:
        self._closed = True
        self.write_eof()

    async def drain(self) -> None:
        if self._last_task is not None:
            await self._last_task

    def is_closing(self) -> bool:
        return self._closed

    async def wait_closed(self) -> None:
        await self.drain()

    def write(self, data: bytes) -> None:
        if self._closed:
            return
        text = data.decode("utf-8", errors="replace")
        self._last_task = asyncio.create_task(self._send(text))

    def writelines(self, data: Iterable[bytes], /) -> None:
        for chunk in data:
            self.write(chunk)

    def write_eof(self) -> None:
        if self._eof_sent:
            return None
        self._eof_sent = True
        self._last_task = asyncio.create_task(self._send("\x04"))
        return None

    async def _send(self, text: str) -> None:
        async with self._lock:
            await self._commands.send_stdin(self._pid, text)


class _E2BProcess:
    def __init__(self, handle: AsyncCommandHandle, commands: Commands) -> None:
        self._handle = handle
        self._stdout = asyncio.StreamReader()
        self._stderr = asyncio.StreamReader()
        self._stdin = _E2BStdin(commands, handle.pid)
        self.stdin: AsyncWritable = self._stdin
        self.stdout: AsyncReadable = self._stdout
        self.stderr: AsyncReadable = self._stderr
        self._returncode: int | None = None
        self._exit_future: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        self._monitor_task = asyncio.create_task(self._monitor())

    @property
    def pid(self) -> int:
        return self._handle.pid

    @property
    def returncode(self) -> int | None:
        return self._returncode

    async def wait(self) -> int:
        return await self._exit_future

    async def kill(self) -> None:
        await self._handle.kill()

    def feed_stdout(self, chunk: str) -> None:
        if chunk:
            self._stdout.feed_data(chunk.encode("utf-8", "replace"))

    def feed_stderr(self, chunk: str) -> None:
        if chunk:
            self._stderr.feed_data(chunk.encode("utf-8", "replace"))

    async def _monitor(self) -> None:
        exit_code = 1
        try:
            result: CommandResult = await self._handle.wait()
            exit_code = result.exit_code
        except CommandExitException as exc:
            exit_code = exc.exit_code
        except Exception as exc:
            self.feed_stderr(f"[e2b command error] {exc}\n")
        finally:
            self._returncode = exit_code
            self._stdout.feed_eof()
            self._stderr.feed_eof()
            if not self._exit_future.done():
                self._exit_future.set_result(exit_code)


class E2BKaos:
    """
    KAOS backend for an existing E2B AsyncSandbox.

    Sandbox lifecycle is managed externally; this class never creates or kills sandboxes.

    Docs:
    - E2B user/workdir defaults: https://e2b.dev/docs/template/user-and-workdir
    - E2B commands/filesystem: https://e2b.dev/docs/commands / https://e2b.dev/docs/filesystem
    """

    name: str = "e2b"

    def __init__(
        self,
        sandbox: AsyncSandbox,
        *,
        home_dir: str = "/home/user",
        cwd: str | None = None,
        user: str | None = None,
        request_timeout: float | None = None,
    ) -> None:
        self._sandbox = sandbox
        self._home_dir = posixpath.normpath(home_dir)
        self._cwd = posixpath.normpath(cwd) if cwd is not None else self._home_dir
        self._user = user
        self._request_timeout = request_timeout

    def pathclass(self) -> type[PurePosixPath]:
        return PurePosixPath

    def normpath(self, path: StrOrKaosPath) -> KaosPath:
        return KaosPath(posixpath.normpath(str(path)))

    def gethome(self) -> KaosPath:
        return KaosPath(self._home_dir)

    def getcwd(self) -> KaosPath:
        return KaosPath(self._cwd)

    async def chdir(self, path: StrOrKaosPath) -> None:
        abs_path = self._abs_path(path)
        try:
            info: EntryInfo = await self._sandbox.files.get_info(
                abs_path,
                user=self._user,
                request_timeout=self._request_timeout,
            )
        except NotFoundException as exc:
            raise FileNotFoundError(abs_path) from exc
        if info.type != FileType.DIR:
            raise NotADirectoryError(f"{abs_path} is not a directory")
        self._cwd = abs_path

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
        del follow_symlinks
        abs_path = self._abs_path(path)
        try:
            info: EntryInfo = await self._sandbox.files.get_info(
                abs_path,
                user=self._user,
                request_timeout=self._request_timeout,
            )
        except NotFoundException as exc:
            raise FileNotFoundError(abs_path) from exc
        mode = self._with_type_bits(info)
        mtime = self._to_timestamp(info.modified_time)
        return StatResult(
            st_mode=mode,
            st_ino=0,
            st_dev=0,
            st_nlink=1,
            st_uid=0,
            st_gid=0,
            st_size=info.size,
            st_atime=mtime,
            st_mtime=mtime,
            st_ctime=mtime,
        )

    async def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        abs_path = self._abs_path(path)
        entries: list[EntryInfo] = await self._sandbox.files.list(
            abs_path,
            depth=1,
            user=self._user,
            request_timeout=self._request_timeout,
        )
        for entry in entries:
            if entry.path == abs_path:
                continue
            yield KaosPath(entry.path)

    async def glob(
        self, path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
    ) -> AsyncGenerator[KaosPath]:
        if not case_sensitive:
            raise ValueError("Case insensitive glob is not supported in current environment")
        abs_path = self._abs_path(path)
        entries: list[EntryInfo] = await self._sandbox.files.list(
            abs_path,
            depth=1,
            user=self._user,
            request_timeout=self._request_timeout,
        )
        for entry in entries:
            if entry.path == abs_path:
                continue
            if self._fnmatch(entry.name, pattern):
                yield KaosPath(entry.path)

    async def readbytes(self, path: StrOrKaosPath, n: int | None = None) -> bytes:
        abs_path = self._abs_path(path)
        data: bytes | bytearray = await self._sandbox.files.read(
            abs_path,
            format="bytes",
            user=self._user,
            request_timeout=self._request_timeout,
        )
        payload = bytes(data)
        return payload if n is None else payload[:n]

    async def readtext(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        del encoding, errors
        abs_path = self._abs_path(path)
        result: str = await self._sandbox.files.read(
            abs_path,
            format="text",
            user=self._user,
            request_timeout=self._request_timeout,
        )
        return result

    async def readlines(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        text = await self.readtext(path, encoding=encoding, errors=errors)
        for line in text.splitlines(keepends=True):
            yield line

    async def writebytes(self, path: StrOrKaosPath, data: bytes) -> int:
        abs_path = self._abs_path(path)
        await self._sandbox.files.write(  # type: ignore[reportUnknownMemberType]
            abs_path,
            data,
            user=self._user,
            request_timeout=self._request_timeout,
        )
        return len(data)

    async def writetext(
        self,
        path: StrOrKaosPath,
        data: str,
        *,
        mode: Literal["w", "a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        del encoding, errors
        abs_path = self._abs_path(path)
        if mode == "a":
            data = await self._read_for_append(abs_path) + data
        await self._sandbox.files.write(  # type: ignore[reportUnknownMemberType]
            abs_path,
            data,
            user=self._user,
            request_timeout=self._request_timeout,
        )
        return len(data)

    async def mkdir(
        self, path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False
    ) -> None:
        abs_path = self._abs_path(path)
        existing = await self._get_info(abs_path)
        if existing is not None:
            if not exist_ok:
                raise FileExistsError(f"{abs_path} already exists")
            if existing.type != FileType.DIR:
                raise FileExistsError(f"{abs_path} already exists and is not a directory")
            return

        if not parents:
            parent = posixpath.dirname(abs_path) or "/"
            parent_info = await self._get_info(parent)
            if parent_info is None:
                raise FileNotFoundError(f"Parent directory {parent} does not exist")
            if parent_info.type != FileType.DIR:
                raise NotADirectoryError(f"Parent path {parent} is not a directory")

        await self._sandbox.files.make_dir(
            abs_path,
            user=self._user,
            request_timeout=self._request_timeout,
        )

    async def exec(self, *args: str) -> KaosProcess:
        if not args:
            raise ValueError("At least one argument (the program to execute) is required.")
        command = " ".join(shlex.quote(arg) for arg in args)
        if self._cwd:
            command = f"cd {shlex.quote(self._cwd)} && {command}"
        process: _E2BProcess | None = None
        stdout_buffer: list[str] = []
        stderr_buffer: list[str] = []

        def on_stdout(chunk: str) -> None:
            if process is None:
                stdout_buffer.append(chunk)
            else:
                process.feed_stdout(chunk)

        def on_stderr(chunk: str) -> None:
            if process is None:
                stderr_buffer.append(chunk)
            else:
                process.feed_stderr(chunk)

        handle: AsyncCommandHandle = await self._sandbox.commands.run(
            command,
            background=True,
            envs=None,
            user=self._user,
            cwd=self._cwd,
            on_stdout=on_stdout,
            on_stderr=on_stderr,
            stdin=True,
            timeout=None,
            request_timeout=self._request_timeout,
        )
        process = _E2BProcess(handle, self._sandbox.commands)
        for chunk in stdout_buffer:
            process.feed_stdout(chunk)
        for chunk in stderr_buffer:
            process.feed_stderr(chunk)
        return process

    async def _read_for_append(self, path: str) -> str:
        try:
            existing: str = await self._sandbox.files.read(
                path,
                format="text",
                user=self._user,
                request_timeout=self._request_timeout,
            )
        except NotFoundException:
            return ""
        return existing

    async def _get_info(self, path: str) -> EntryInfo | None:
        try:
            info: EntryInfo = await self._sandbox.files.get_info(
                path,
                user=self._user,
                request_timeout=self._request_timeout,
            )
            return info
        except NotFoundException:
            return None

    def _abs_path(self, path: StrOrKaosPath) -> str:
        raw = str(path)
        if posixpath.isabs(raw):
            return posixpath.normpath(raw)
        return posixpath.normpath(posixpath.join(self._cwd, raw))

    @staticmethod
    def _fnmatch(name: str, pattern: str) -> bool:
        from fnmatch import fnmatchcase

        return fnmatchcase(name, pattern)

    @staticmethod
    def _to_timestamp(value: datetime) -> float:
        return value.timestamp()

    @staticmethod
    def _with_type_bits(info: EntryInfo) -> int:
        mode = info.mode
        type_mode = stat.S_IFDIR if info.type == FileType.DIR else stat.S_IFREG
        if stat.S_IFMT(mode) == 0:
            mode |= type_mode
        return mode if mode else type_mode
