from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from pathlib import PurePath
from typing import TYPE_CHECKING, Literal, TypeVar, cast

from kaos import Kaos, KaosProcess, StatResult, StrOrKaosPath
from kaos.path import KaosPath

T = TypeVar("T")

if TYPE_CHECKING:

    def type_check(overlay: OverlayKaos) -> None:
        _: Kaos = overlay


class NoBackendError(RuntimeError):
    """Raised when OverlayKaos has no backend to delegate calls to."""

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or "OverlayKaos has no Kaos backends configured.")


class OverlayKaos:
    """
    Try multiple KAOS backends in order until one succeeds.

    Use cases:
    - Automatic fallback across execution environments.
    - Unstable dependencies/permissions where higher availability and resilience are needed.
    - Tiered capability support, where some syscalls are only available on certain backends.

    Best practices:
    - Put the most reliable/fastest backend first; order defines priority.
    - Keep backend semantics consistent (path rules, encoding, permissions, error types).
    - Ensure all stacked backends target a consistent environment (e.g., same OS and shared
      filesystem).
    - Reads can safely fall back; write/exec operations should be idempotent or have
      acceptable side effects.

    Caveats:
    - Exceptions from a backend are captured and the next backend is tried until success,
      otherwise the last exception is raised.
    - For streaming results (iterdir/glob/readlines), once output is yielded, fallback
      will not occur and subsequent errors will be propagated.
    - If all backends are unavailable, the last exception or NoBackendError is raised.
    """

    name: str = "overlay"

    def __init__(self, *kaos_list: Kaos) -> None:
        if len(kaos_list) == 1 and isinstance(kaos_list[0], list | tuple):
            kaos_items = tuple(cast(Sequence[Kaos], kaos_list[0]))
        else:
            kaos_items = tuple(kaos_list)
        if not kaos_items:
            raise ValueError("OverlayKaos requires at least one Kaos backend.")
        self._kaos_list: tuple[Kaos, ...] = kaos_items

    @property
    def kaos_list(self) -> tuple[Kaos, ...]:
        return self._kaos_list

    def _try_sync(self, func: Callable[[Kaos], T]) -> T:
        last_exc: Exception | None = None
        for backend in self._kaos_list:
            try:
                return func(backend)
            except Exception as exc:  # noqa: BLE001 - backend errors are forwarded
                last_exc = exc
        if last_exc is None:
            raise NoBackendError()
        raise last_exc

    async def _try_async(self, func: Callable[[Kaos], Awaitable[T]]) -> T:
        last_exc: Exception | None = None
        for backend in self._kaos_list:
            try:
                return await func(backend)
            except Exception as exc:  # noqa: BLE001 - backend errors are forwarded
                last_exc = exc
        if last_exc is None:
            raise NoBackendError()
        raise last_exc

    def pathclass(self) -> type[PurePath]:
        return self._try_sync(lambda backend: backend.pathclass())

    def normpath(self, path: StrOrKaosPath) -> KaosPath:
        return self._try_sync(lambda backend: backend.normpath(path))

    def gethome(self) -> KaosPath:
        return self._try_sync(lambda backend: backend.gethome())

    def getcwd(self) -> KaosPath:
        return self._try_sync(lambda backend: backend.getcwd())

    async def chdir(self, path: StrOrKaosPath) -> None:
        await self._try_async(lambda backend: backend.chdir(path))

    async def stat(self, path: StrOrKaosPath, *, follow_symlinks: bool = True) -> StatResult:
        return await self._try_async(
            lambda backend: backend.stat(
                path,
                follow_symlinks=follow_symlinks,
            )
        )

    async def iterdir(self, path: StrOrKaosPath) -> AsyncGenerator[KaosPath]:
        last_exc: Exception | None = None
        for backend in self._kaos_list:
            yielded = False
            try:
                async for entry in backend.iterdir(path):
                    yielded = True
                    yield entry
                return
            except Exception as exc:  # noqa: BLE001 - backend errors are forwarded
                if yielded:
                    raise
                last_exc = exc
        if last_exc is None:
            raise NoBackendError()
        raise last_exc

    async def glob(
        self,
        path: StrOrKaosPath,
        pattern: str,
        *,
        case_sensitive: bool = True,
    ) -> AsyncGenerator[KaosPath]:
        last_exc: Exception | None = None
        for backend in self._kaos_list:
            yielded = False
            try:
                async for entry in backend.glob(path, pattern, case_sensitive=case_sensitive):
                    yielded = True
                    yield entry
                return
            except Exception as exc:  # noqa: BLE001 - backend errors are forwarded
                if yielded:
                    raise
                last_exc = exc
        if last_exc is None:
            raise NoBackendError()
        raise last_exc

    async def readbytes(self, path: StrOrKaosPath, n: int | None = None) -> bytes:
        return await self._try_async(lambda backend: backend.readbytes(path, n=n))

    async def readtext(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> str:
        return await self._try_async(
            lambda backend: backend.readtext(
                path,
                encoding=encoding,
                errors=errors,
            )
        )

    async def readlines(
        self,
        path: StrOrKaosPath,
        *,
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> AsyncGenerator[str]:
        last_exc: Exception | None = None
        for backend in self._kaos_list:
            yielded = False
            try:
                async for line in backend.readlines(path, encoding=encoding, errors=errors):
                    yielded = True
                    yield line
                return
            except Exception as exc:  # noqa: BLE001 - backend errors are forwarded
                if yielded:
                    raise
                last_exc = exc
        if last_exc is None:
            raise NoBackendError()
        raise last_exc

    async def writebytes(self, path: StrOrKaosPath, data: bytes) -> int:
        return await self._try_async(lambda backend: backend.writebytes(path, data))

    async def writetext(
        self,
        path: StrOrKaosPath,
        data: str,
        *,
        mode: Literal["w", "a"] = "w",
        encoding: str = "utf-8",
        errors: Literal["strict", "ignore", "replace"] = "strict",
    ) -> int:
        return await self._try_async(
            lambda backend: backend.writetext(
                path,
                data,
                mode=mode,
                encoding=encoding,
                errors=errors,
            )
        )

    async def mkdir(
        self,
        path: StrOrKaosPath,
        parents: bool = False,
        exist_ok: bool = False,
    ) -> None:
        await self._try_async(
            lambda backend: backend.mkdir(
                path,
                parents=parents,
                exist_ok=exist_ok,
            )
        )

    async def exec(self, *args: str) -> KaosProcess:
        return await self._try_async(lambda backend: backend.exec(*args))
