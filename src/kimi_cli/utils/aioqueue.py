from __future__ import annotations

import asyncio
import contextlib
import sys

if sys.version_info >= (3, 13):
    QueueShutDown = asyncio.QueueShutDown  # type: ignore[assignment]

    class Queue[T](asyncio.Queue[T]):
        """Asyncio Queue with shutdown support (Python 3.13+ native)."""

        def __init__(self, *, maxsize: int = 0) -> None:
            super().__init__(maxsize=maxsize)

else:

    class QueueShutDown(Exception):
        """Raised when operating on a shut down queue."""

    class _Shutdown:
        """Sentinel for queue shutdown."""

    _SHUTDOWN = _Shutdown()

    class Queue[T](asyncio.Queue[T | _Shutdown]):
        """Asyncio Queue with shutdown support for Python < 3.13."""

        def __init__(self, *, maxsize: int = 0) -> None:
            super().__init__(maxsize=maxsize)
            self._shutdown = False

        def shutdown(self, immediate: bool = False) -> None:
            if self._shutdown:
                return
            self._shutdown = True
            if immediate:
                self._queue.clear()  # type: ignore[attr-defined]

            # Wake all getters so they can drain remaining items or see
            # QueueShutDown on the next get() call.
            while getattr(self, "_getters", []):
                with contextlib.suppress(IndexError):
                    self._wakeup_next(self._getters)  # type: ignore[attr-defined]

            # Wake all putters so they re-check shutdown instead of
            # hanging on a full bounded queue.
            while getattr(self, "_putters", []):
                with contextlib.suppress(IndexError):
                    self._wakeup_next(self._putters)  # type: ignore[attr-defined]

        async def get(self) -> T:
            if self._shutdown and self.empty():
                raise QueueShutDown
            item = await super().get()
            if isinstance(item, _Shutdown):
                raise QueueShutDown
            return item

        def get_nowait(self) -> T:
            if self._shutdown and self.empty():
                raise QueueShutDown
            item = super().get_nowait()
            if isinstance(item, _Shutdown):
                raise QueueShutDown
            return item

        async def put(self, item: T) -> None:
            if self._shutdown:
                raise QueueShutDown
            await super().put(item)
            # Re-check shutdown after waking from a full-queue wait;
            # the queue may have been shut down while we were blocked.
            if self._shutdown:
                raise QueueShutDown

        def put_nowait(self, item: T) -> None:
            if self._shutdown:
                raise QueueShutDown
            super().put_nowait(item)
