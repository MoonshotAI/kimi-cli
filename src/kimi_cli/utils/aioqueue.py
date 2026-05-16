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

    class Queue[T](asyncio.Queue[T]):
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

            # Wake all getters so they can check the shutdown flag and
            # raise QueueShutDown instead of re-blocking forever.
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
            while self.empty():
                getter = asyncio.get_running_loop().create_future()
                self._getters.append(getter)
                try:
                    await getter
                finally:
                    with contextlib.suppress(ValueError):
                        self._getters.remove(getter)
                if self._shutdown:
                    raise QueueShutDown
            return super().get_nowait()

        def get_nowait(self) -> T:
            if self._shutdown and self.empty():
                raise QueueShutDown
            return super().get_nowait()

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
