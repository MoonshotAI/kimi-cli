from __future__ import annotations

import asyncio
import sys

if sys.version_info >= (3, 13):
    QueueShutDown = asyncio.QueueShutDown  # type: ignore[assignment]

    class Queue[T](asyncio.Queue[T]):
        """Asyncio Queue with shutdown support."""

else:

    class QueueShutDown(Exception):
        """Raised when operating on a shut down queue."""

    class _Shutdown:
        """Sentinel for queue shutdown."""

    _SHUTDOWN = _Shutdown()

    class Queue[T](asyncio.Queue[T | _Shutdown]):
        """Asyncio Queue with shutdown support for Python < 3.13."""

        def __init__(self) -> None:
            super().__init__()
            self._shutdown = False

        def shutdown(self, immediate: bool = False) -> None:
            if self._shutdown:
                return
            self._shutdown = True
            if immediate:
                self._queue.clear()

            getters = list(getattr(self, "_getters", []))
            count = max(1, len(getters))
            self._enqueue_shutdown(count)

        def _enqueue_shutdown(self, count: int) -> None:
            for _ in range(count):
                try:
                    super().put_nowait(_SHUTDOWN)
                except asyncio.QueueFull:
                    self._queue.clear()
                    super().put_nowait(_SHUTDOWN)

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

        def put_nowait(self, item: T) -> None:
            if self._shutdown:
                raise QueueShutDown
            super().put_nowait(item)
