from __future__ import annotations

import logging
import posixpath
import shlex
import stat
import sys
from collections.abc import AsyncGenerator
from pathlib import PurePath, PurePosixPath
from typing import TYPE_CHECKING, Literal, TextIO

import asyncssh
from asyncssh.constants import (
    FILEXFER_TYPE_BLOCK_DEVICE,
    FILEXFER_TYPE_CHAR_DEVICE,
    FILEXFER_TYPE_DIRECTORY,
    FILEXFER_TYPE_FIFO,
    FILEXFER_TYPE_REGULAR,
    FILEXFER_TYPE_SOCKET,
    FILEXFER_TYPE_SYMLINK,
)

from kaos import (
    AsyncReadable,
    AsyncWritable,
    Kaos,
    KaosProcess,
    StatResult,
    StrOrKaosPath,
)
from kaos.path import KaosPath

if TYPE_CHECKING:

    def type_check(ssh: SSHKaos) -> None:
        _: Kaos = ssh


_FILEXFER_TYPE_TO_MODE = {
    FILEXFER_TYPE_REGULAR: stat.S_IFREG,
    FILEXFER_TYPE_DIRECTORY: stat.S_IFDIR,
    FILEXFER_TYPE_SYMLINK: stat.S_IFLNK,
    FILEXFER_TYPE_SOCKET: stat.S_IFSOCK,
    FILEXFER_TYPE_CHAR_DEVICE: stat.S_IFCHR,
    FILEXFER_TYPE_BLOCK_DEVICE: stat.S_IFBLK,
    FILEXFER_TYPE_FIFO: stat.S_IFIFO,
}


def _build_st_mode(attrs: asyncssh.SFTPAttrs) -> int:
    """Combine SFTP permissions and type information into st_mode."""

    perm_mode = attrs.permissions or 0
    type_mode = _FILEXFER_TYPE_TO_MODE.get(attrs.type, 0)

    if perm_mode:
        if type_mode and stat.S_IFMT(perm_mode) == 0:
            perm_mode |= type_mode
        return perm_mode

    return type_mode


def _sec_with_nanos(sec: int, ns: int | None) -> float:
    if ns is None:
        return float(sec)
    return float(sec) + (ns / 1_000_000_000.0)


def _enable_ssh_logging(
    *,
    stream: TextIO = sys.stderr,
    level: int = logging.INFO,
) -> None:
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    logger = logging.getLogger(__name__)
    logger.setLevel(level)
    if any(isinstance(handler, logging.StreamHandler) for handler in logger.handlers):
        return
    handler = logging.StreamHandler(stream)
    handler.setLevel(level)
    handler.setFormatter(formatter)
    logger.addHandler(handler)


class SSHKaos:
    """
    A KAOS implementation that interacts with a remote machine via SSH and SFTP.
    """

    name: str = "ssh"

    class Process:
        """KAOS process wrapper around asyncssh.SSHClientProcess."""

        def __init__(self, process: asyncssh.SSHClientProcess[bytes]) -> None:
            self._process = process
            self.stdin: AsyncWritable = process.stdin
            self.stdout: AsyncReadable = process.stdout
            self.stderr: AsyncReadable = process.stderr

        @property
        def pid(self) -> int:
            # FIXME: SSHClientProcess does not have a pid attribute.
            return -1

        @property
        def returncode(self) -> int | None:
            return self._process.returncode

        async def wait(self) -> int:
            # asyncssh.SSHClientProcess.wait() drains stdout/stderr via communicate()
            # which clears the internal receive buffers. Use wait_closed() so
            # stdout/stderr remain readable after wait, matching LocalKaos.
            await self._process.wait_closed()
            return 1 if self._process.returncode is None else self._process.returncode

        async def kill(self) -> None:
            self._process.kill()

    @classmethod
    async def create(
        cls,
        host: str,
        *,
        port: int = 22,
        username: str | None = None,
        password: str | None = None,
        key_paths: list[str] | None = None,
        key_contents: list[str] | None = None,
        cwd: str | None = None,
        log_exc: bool = False,
        **extra_options: object,
    ):
        if log_exc:
            _enable_ssh_logging()

        options = {
            "host": host,
            "port": port,
            **extra_options,
        }
        if username:
            options["username"] = username
        if password:
            options["password"] = password
        client_keys: list[str | asyncssh.SSHKey] = []
        if key_contents:
            client_keys.extend([asyncssh.import_private_key(key) for key in key_contents])
        if key_paths:
            client_keys.extend(key_paths)
        if client_keys:
            options["client_keys"] = client_keys
        # Ensure encoding is None to read/write bytes
        options["encoding"] = None
        # Known hosts is None to avoid the "Host key is not trusted" error
        options["known_hosts"] = None
        # Connect to ssh
        try:
            connection = await asyncssh.connect(**options)
        except Exception as exc:
            if log_exc:
                logging.getLogger(__name__).exception(
                    "SSH connection failed (host=%s, port=%s, error=%s)",
                    host,
                    port,
                    exc,
                )
            raise
        try:
            sftp = await connection.start_sftp_client()
            home_dir = await sftp.realpath(".")
            if cwd is not None:
                await sftp.chdir(cwd)
                cwd = await sftp.realpath(".")
            else:
                cwd = home_dir
        except Exception as exc:
            if log_exc:
                logging.getLogger(__name__).exception(
                    "SSH session initialization failed (host=%s, port=%s, error=%s)",
                    host,
                    port,
                    exc,
                )
            connection.close()
            raise
        return cls(
            connection=connection,
            sftp=sftp,
            home=home_dir,
            cwd=cwd,
            host=host,
            log_exc=log_exc,
        )

    def __init__(
        self,
        *,
        connection: asyncssh.SSHClientConnection,
        sftp: asyncssh.SFTPClient,
        home: str,
        cwd: str,
        host: str,
        log_exc: bool = False,
    ) -> None:
        self._connection = connection
        self._sftp = sftp
        self._home_dir = home
        self._cwd = cwd
        self._host = host
        self._log_exc = log_exc

    def _log_exception(self, message: str, *args: object) -> None:
        if self._log_exc:
            logging.getLogger(__name__).exception(message, *args)

    @property
    def host(self) -> str:
        return self._host

    def pathclass(self) -> type[PurePath]:
        return PurePosixPath

    def normpath(self, path: StrOrKaosPath) -> KaosPath:
        return KaosPath(posixpath.normpath(str(path)))

    def gethome(self) -> KaosPath:
        return KaosPath(self._home_dir)

    def getcwd(self) -> KaosPath:
        return KaosPath(self._cwd)

    async def chdir(self, path: StrOrKaosPath) -> None:
        try:
            await self._sftp.chdir(str(path))
            self._cwd = await self._sftp.realpath(".")
        except Exception as exc:
            self._log_exception(
                "SSH chdir failed (host=%s, path=%s, error=%s)", self._host, path, exc
            )
            raise

    async def stat(
        self,
        path: StrOrKaosPath,
        *,
        follow_symlinks: bool = True,
    ) -> StatResult:
        try:
            st = await self._sftp.stat(str(path), follow_symlinks=follow_symlinks)
        except asyncssh.SFTPError as e:
            self._log_exception(
                "SSH stat failed (host=%s, path=%s, follow_symlinks=%s, error=%s)",
                self._host,
                path,
                follow_symlinks,
                e,
            )
            raise OSError from e

        return StatResult(
            st_mode=_build_st_mode(st),
            st_uid=st.uid or 0,
            st_gid=st.gid or 0,
            st_size=st.size or 0,
            st_atime=_sec_with_nanos(st.atime or 0, st.atime_ns),
            st_mtime=_sec_with_nanos(st.mtime or 0, st.mtime_ns),
            st_ctime=_sec_with_nanos(st.ctime or 0, st.ctime_ns),
            st_ino=0,  # sftp does not support ino
            st_dev=0,  # sftp does not support dev
            st_nlink=st.nlink or 0,
        )

    async def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        kaos_path = KaosPath(path) if isinstance(path, str) else path
        try:
            for entry in await self._sftp.listdir(str(path)):
                # NOTE: sftp listdir gives . and ..
                if entry in {".", ".."}:
                    continue
                yield kaos_path / entry
        except Exception as exc:
            self._log_exception(
                "SSH iterdir failed (host=%s, path=%s, error=%s)", self._host, path, exc
            )
            raise

    async def glob(
        self,
        path: StrOrKaosPath,
        pattern: str,
        *,
        case_sensitive: bool = True,
    ) -> AsyncGenerator[KaosPath]:
        if not case_sensitive:
            raise ValueError("Case insensitive glob is not supported in current environment")
        try:
            real_path = await self._sftp.realpath(str(path))
            for entry in await self._sftp.glob(f"{real_path}/{pattern}"):
                yield KaosPath(await self._sftp.realpath(str(entry)))
        except Exception as exc:
            self._log_exception(
                "SSH glob failed (host=%s, path=%s, pattern=%s, error=%s)",
                self._host,
                path,
                pattern,
                exc,
            )
            raise

    async def readbytes(self, path: StrOrKaosPath, n: int | None = None) -> bytes:
        try:
            async with self._sftp.open(str(path), "rb") as f:
                return await f.read() if n is None else await f.read(n)
        except Exception as exc:
            self._log_exception(
                "SSH readbytes failed (host=%s, path=%s, error=%s)",
                self._host,
                path,
                exc,
            )
            raise

    async def readtext(
        self,
        path: str | KaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        try:
            async with self._sftp.open(str(path), "r", encoding=encoding, errors=errors) as f:
                return await f.read()
        except Exception as exc:
            self._log_exception(
                "SSH readtext failed (host=%s, path=%s, error=%s)",
                self._host,
                path,
                exc,
            )
            raise

    async def readlines(
        self,
        path: str | KaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        # NOTE: readlines is not supported by SFTPClientFile
        text = await self.readtext(path, encoding=encoding, errors=errors)
        for line in text.splitlines():
            yield line

    async def writebytes(self, path: StrOrKaosPath, data: bytes) -> int:
        try:
            async with self._sftp.open(str(path), "wb") as f:
                return await f.write(data)
        except Exception as exc:
            self._log_exception(
                "SSH writebytes failed (host=%s, path=%s, error=%s)",
                self._host,
                path,
                exc,
            )
            raise

    async def writetext(
        self,
        path: str | KaosPath,
        data: str,
        *,
        mode: Literal["w"] | Literal["a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        try:
            async with self._sftp.open(str(path), mode, encoding=encoding, errors=errors) as f:
                return await f.write(data)
        except Exception as exc:
            self._log_exception(
                "SSH writetext failed (host=%s, path=%s, error=%s)",
                self._host,
                path,
                exc,
            )
            raise

    async def mkdir(
        self,
        path: StrOrKaosPath,
        parents: bool = False,
        exist_ok: bool = False,
    ) -> None:
        try:
            if parents:
                await self._sftp.makedirs(str(path), exist_ok=exist_ok)
            else:
                existed = await self._sftp.exists(str(path))
                if existed and not exist_ok:
                    raise FileExistsError(f"{path} already exists")
                await self._sftp.mkdir(str(path))
        except Exception as exc:
            self._log_exception(
                "SSH mkdir failed (host=%s, path=%s, parents=%s, exist_ok=%s, error=%s)",
                self._host,
                path,
                parents,
                exist_ok,
                exc,
            )
            raise

    async def exec(self, *args: str) -> KaosProcess:
        if not args:
            raise ValueError("At least one argument (the program to execute) is required.")
        command = " ".join(shlex.quote(arg) for arg in args)
        # NOTE:
        # - SFTP has its own concept of working directory; it does not affect SSH exec.
        # - To make exec behave like other KAOS backends, we explicitly `cd` to our tracked
        #   cwd before running the command.
        #
        # This is intentionally strict: if cwd doesn't exist, the command fails.
        if self._cwd:
            command = f"cd {shlex.quote(self._cwd)} && {command}"
        try:
            process = await self._connection.create_process(command, encoding=None)
            return self.Process(process)
        except Exception as exc:
            self._log_exception(
                "SSH exec failed (host=%s, command=%s, error=%s)",
                self._host,
                command,
                exc,
            )
            raise

    async def unsafe_close(self) -> None:
        """Close the SSH connection. After that, SSHKaos will be unusable."""
        try:
            if self._sftp:
                self._sftp.exit()
            if self._connection:
                self._connection.close()
        except Exception as exc:
            self._log_exception("SSH close failed (host=%s, error=%s)", self._host, exc)
            raise
