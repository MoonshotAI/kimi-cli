from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterable
from contextlib import suppress
from typing import Literal

import acp
from kaos import AsyncReadable, AsyncWritable, Kaos, KaosProcess, StatResult, StrOrKaosPath
from kaos.local import local_kaos
from kaos.path import KaosPath

_DEFAULT_TERMINAL_OUTPUT_LIMIT = 50_000
_DEFAULT_POLL_INTERVAL = 0.2
_TRUNCATION_NOTICE = "[acp output truncated]\n"


class _NullWritable:
    def can_write_eof(self) -> bool:
        return False

    def close(self) -> None:
        return None

    async def drain(self) -> None:
        return None

    def is_closing(self) -> bool:
        return False

    async def wait_closed(self) -> None:
        return None

    def write(self, data: bytes) -> None:
        return None

    def writelines(self, data: Iterable[bytes], /) -> None:
        return None

    def write_eof(self) -> None:
        return None


class ACPProcess:
    """KAOS process adapter for ACP terminal execution."""

    def __init__(
        self,
        terminal: acp.TerminalHandle,
        *,
        poll_interval: float = _DEFAULT_POLL_INTERVAL,
    ) -> None:
        self._terminal = terminal
        self._poll_interval = poll_interval
        self._stdin = _NullWritable()
        self._stdout = asyncio.StreamReader()
        self._stderr = asyncio.StreamReader()
        self.stdin: AsyncWritable = self._stdin
        self.stdout: AsyncReadable = self._stdout
        # ACP does not expose stderr separately; keep stderr empty.
        self.stderr: AsyncReadable = self._stderr
        self._returncode: int | None = None
        self._last_output = ""
        self._truncation_noted = False
        self._exit_future: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        self._poll_task = asyncio.create_task(self._poll_output())

    @property
    def pid(self) -> int:
        return -1

    @property
    def returncode(self) -> int | None:
        return self._returncode

    async def wait(self) -> int:
        return await self._exit_future

    async def kill(self) -> None:
        await self._terminal.kill()

    def _feed_output(self, output_response: acp.schema.TerminalOutputResponse) -> None:
        output = output_response.output
        reset = output_response.truncated or (
            self._last_output and not output.startswith(self._last_output)
        )
        if reset and self._last_output and not self._truncation_noted:
            self._stdout.feed_data(_TRUNCATION_NOTICE.encode("utf-8"))
            self._truncation_noted = True

        delta = output if reset else output[len(self._last_output) :]
        if delta:
            self._stdout.feed_data(delta.encode("utf-8", "replace"))
        self._last_output = output

    @staticmethod
    def _normalize_exit_code(exit_code: int | None) -> int:
        return 1 if exit_code is None else exit_code

    async def _poll_output(self) -> None:
        exit_task = asyncio.create_task(self._terminal.wait_for_exit())
        exit_code: int | None = None
        try:
            while True:
                if exit_task.done():
                    exit_response = exit_task.result()
                    exit_code = exit_response.exit_code
                    break

                output_response = await self._terminal.current_output()
                self._feed_output(output_response)
                if output_response.exit_status:
                    exit_code = output_response.exit_status.exit_code
                    try:
                        exit_response = await exit_task
                        exit_code = exit_response.exit_code or exit_code
                    except Exception:
                        pass
                    break

                await asyncio.sleep(self._poll_interval)

            final_output = await self._terminal.current_output()
            self._feed_output(final_output)
        except Exception as exc:
            error_note = f"[acp terminal error] {exc}\n"
            self._stdout.feed_data(error_note.encode("utf-8", "replace"))
            if exit_code is None:
                exit_code = 1
        finally:
            if not exit_task.done():
                exit_task.cancel()
                with suppress(Exception):
                    await exit_task
            self._returncode = self._normalize_exit_code(exit_code)
            self._stdout.feed_eof()
            self._stderr.feed_eof()
            if not self._exit_future.done():
                self._exit_future.set_result(self._returncode)
            with suppress(Exception):
                await self._terminal.release()


class ACPKaos:
    """KAOS backend that routes supported operations through ACP."""

    name: str = "acp"

    def __init__(
        self,
        client: acp.Client,
        session_id: str,
        client_capabilities: acp.schema.ClientCapabilities | None,
        fallback: Kaos | None = None,
        *,
        output_byte_limit: int | None = _DEFAULT_TERMINAL_OUTPUT_LIMIT,
        poll_interval: float = _DEFAULT_POLL_INTERVAL,
    ) -> None:
        self._client = client
        self._session_id = session_id
        self._fallback = fallback or local_kaos
        fs = client_capabilities.fs if client_capabilities else None
        self._supports_read = bool(fs and fs.read_text_file)
        self._supports_write = bool(fs and fs.write_text_file)
        self._supports_terminal = bool(client_capabilities and client_capabilities.terminal)
        self._output_byte_limit = output_byte_limit
        self._poll_interval = poll_interval

    def pathclass(self):
        return self._fallback.pathclass()

    def normpath(self, path: StrOrKaosPath) -> KaosPath:
        return self._fallback.normpath(path)

    def gethome(self) -> KaosPath:
        return self._fallback.gethome()

    def getcwd(self) -> KaosPath:
        return self._fallback.getcwd()

    async def chdir(self, path: StrOrKaosPath) -> None:
        await self._fallback.chdir(path)

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
        return await self._fallback.stat(path, follow_symlinks=follow_symlinks)

    def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        return self._fallback.iterdir(path)

    def glob(
        self, path: StrOrKaosPath, pattern: str, *, case_sensitive: bool = True
    ) -> AsyncGenerator[KaosPath]:
        return self._fallback.glob(path, pattern, case_sensitive=case_sensitive)

    async def readbytes(self, path: StrOrKaosPath) -> bytes:
        return await self._fallback.readbytes(path)

    async def readtext(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        abs_path = self._abs_path(path)
        if not self._supports_read:
            return await self._fallback.readtext(abs_path, encoding=encoding, errors=errors)
        response = await self._client.read_text_file(path=abs_path, session_id=self._session_id)
        return response.content

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
        return await self._fallback.writebytes(path, data)

    async def writetext(
        self,
        path: StrOrKaosPath,
        data: str,
        *,
        mode: Literal["w", "a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        abs_path = self._abs_path(path)
        if mode == "a":
            if self._supports_read and self._supports_write:
                existing = await self.readtext(abs_path, encoding=encoding, errors=errors)
                await self._client.write_text_file(
                    path=abs_path,
                    content=existing + data,
                    session_id=self._session_id,
                )
                return len(data)
            return await self._fallback.writetext(
                abs_path, data, mode="a", encoding=encoding, errors=errors
            )

        if not self._supports_write:
            return await self._fallback.writetext(
                abs_path, data, mode=mode, encoding=encoding, errors=errors
            )

        await self._client.write_text_file(
            path=abs_path,
            content=data,
            session_id=self._session_id,
        )
        return len(data)

    async def mkdir(
        self, path: StrOrKaosPath, parents: bool = False, exist_ok: bool = False
    ) -> None:
        await self._fallback.mkdir(path, parents=parents, exist_ok=exist_ok)

    async def exec(self, *args: str) -> KaosProcess:
        return await self._fallback.exec(*args)

    def _abs_path(self, path: StrOrKaosPath) -> str:
        kaos_path = path if isinstance(path, KaosPath) else KaosPath(path)
        return str(kaos_path.canonical())
