from __future__ import annotations

import contextvars
from collections.abc import AsyncGenerator, AsyncIterator, Iterable
from dataclasses import dataclass
from pathlib import PurePath
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

if TYPE_CHECKING:
    from asyncio import StreamReader, StreamWriter

    from asyncssh.stream import SSHReader, SSHWriter

    from kaos.path import KaosPath

    def type_check(
        stream_reader: StreamReader,
        stream_writer: StreamWriter,
        ssh_reader: SSHReader[bytes],
        ssh_writer: SSHWriter[bytes],
    ):
        _reader: AsyncReadable = stream_reader
        _reader = ssh_reader
        _writer: AsyncWritable = stream_writer
        _writer = ssh_writer


type StrOrKaosPath = str | KaosPath


@runtime_checkable
class AsyncReadable(Protocol):
    """Protocol describing readable async byte streams."""

    def __aiter__(self) -> AsyncIterator[bytes]:
        """Yield chunks (typically lines) as they arrive."""
        ...

    def at_eof(self) -> bool:
        """Return True when the stream has reached EOF and buffer is empty."""
        ...

    def feed_data(self, data: bytes) -> None:
        """Inject data into the stream; mainly for testing or adapters."""
        ...

    def feed_eof(self) -> None:
        """Signal end-of-file to the stream."""
        ...

    async def read(self, n: int = -1) -> bytes:
        """Read up to n bytes; -1 reads until EOF."""
        ...

    async def readline(self) -> bytes:
        """Read a single line ending with newline or EOF."""
        ...

    async def readexactly(self, n: int) -> bytes:
        """Read exactly n bytes or raise IncompleteReadError."""
        ...

    async def readuntil(self, separator: bytes) -> bytes:
        """Read until separator is encountered, including the separator."""
        ...


@runtime_checkable
class AsyncWritable(Protocol):
    """Protocol describing writable async byte streams."""

    def can_write_eof(self) -> bool:
        """Return True if write_eof() is supported."""
        ...

    def close(self) -> None:
        """Schedule closing of the underlying transport."""
        ...

    async def drain(self) -> None:
        """Block until the internal write buffer is flushed."""
        ...

    def is_closing(self) -> bool:
        """Return True once the stream has been closed or is closing."""
        ...

    async def wait_closed(self) -> None:
        """Wait until the closing handshake completes."""
        ...

    def write(self, data: bytes) -> None:
        """Write raw bytes to the stream."""
        ...

    def writelines(self, data: Iterable[bytes], /) -> None:
        """Write an iterable of byte chunks to the stream."""
        ...

    def write_eof(self) -> None:
        """Send EOF to the underlying transport if supported."""
        ...


@runtime_checkable
class KaosProcess(Protocol):
    """Process interface exposed by KAOS `exec` implementations."""

    stdin: AsyncWritable
    stdout: AsyncReadable
    stderr: AsyncReadable

    @property
    def pid(self) -> int:
        """Get the process ID."""
        ...

    @property
    def returncode(self) -> int | None:
        """Get the process return code, or None if it is still running."""
        ...

    async def wait(self) -> int:
        """Wait for the process to complete and return the exit code."""
        ...

    async def kill(self) -> None:
        """Kill the process."""
        ...


@runtime_checkable
class Kaos(Protocol):
    """Kimi Agent Operating System (KAOS) interface."""

    name: str
    """The name of the KAOS implementation."""

    def pathclass(self) -> type[PurePath]:
        """Get the path class used under `KaosPath`."""
        ...

    def normpath(self, path: StrOrKaosPath) -> KaosPath:
        """Normalize path, eliminating double slashes, etc."""
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

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
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

    async def readbytes(self, path: StrOrKaosPath, n: int | None = None) -> bytes:
        """Read the entire file contents as bytes, or the first n bytes if provided."""
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

    async def writebytes(self, path: StrOrKaosPath, data: bytes) -> int:
        """Write bytes data to the file."""
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

    async def exec(self, *args: str) -> KaosProcess:
        """
        Execute a command with arguments and return the running process.
        """
        ...


@dataclass
class StatResult:
    """KAOS stat result data class."""

    st_mode: int
    st_ino: int
    st_dev: int
    st_nlink: int
    st_uid: int
    st_gid: int
    st_size: int
    st_atime: float
    st_mtime: float
    st_ctime: float


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


def normpath(path: StrOrKaosPath) -> KaosPath:
    return get_current_kaos().normpath(path)


def gethome() -> KaosPath:
    return get_current_kaos().gethome()


def getcwd() -> KaosPath:
    return get_current_kaos().getcwd()


async def chdir(path: StrOrKaosPath) -> None:
    await get_current_kaos().chdir(path)


async def stat(path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
    return await get_current_kaos().stat(path, follow_symlinks=follow_symlinks)


def iterdir(path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
    return get_current_kaos().iterdir(path)


def glob(
    path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
) -> AsyncGenerator[KaosPath]:
    return get_current_kaos().glob(path, pattern, case_sensitive=case_sensitive)


async def readbytes(path: StrOrKaosPath, n: int | None = None) -> bytes:
    return await get_current_kaos().readbytes(path, n=n)


async def readtext(
    path: StrOrKaosPath,
    *,
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> str:
    return await get_current_kaos().readtext(path, encoding=encoding, errors=errors)


def readlines(
    path: StrOrKaosPath,
    *,
    encoding: str = "utf-8",
    errors: Literal["strict", "ignore", "replace"] = "strict",
) -> AsyncGenerator[str]:
    return get_current_kaos().readlines(path, encoding=encoding, errors=errors)


async def writebytes(path: StrOrKaosPath, data: bytes) -> int:
    return await get_current_kaos().writebytes(path, data)


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


async def exec(*args: str) -> KaosProcess:
    return await get_current_kaos().exec(*args)
