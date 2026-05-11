import asyncio
import contextlib

from kimi_cli.utils.aioqueue import Queue

_DEFAULT_MAXSIZE = 1000


class BroadcastQueue[T]:
    """A broadcast queue that allows multiple subscribers to receive published items.

    Each subscriber gets its own bounded queue (default maxsize=1000) to
    prevent unbounded memory growth when a consumer is slower than the
    producer.  When a subscriber's queue is full, the oldest item is
    dropped to make room for the new one.
    """

    def __init__(self, *, maxsize: int = _DEFAULT_MAXSIZE) -> None:
        self._queues: set[Queue[T]] = set()
        self._maxsize = maxsize

    def subscribe(self, *, maxsize: int | None = None) -> Queue[T]:
        """Create a new subscription queue.

        Args:
            maxsize: Maximum queue size.  ``None`` uses the broadcast
                queue's default (bounded).  ``0`` means unbounded.
        """
        queue: Queue[T] = Queue(maxsize=maxsize if maxsize is not None else self._maxsize)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: Queue[T]) -> None:
        """Remove a subscription queue."""
        self._queues.discard(queue)

    async def publish(self, item: T) -> None:
        """Publish an item to all subscription queues.

        If a subscriber's queue is full, the oldest item is dropped so
        that publication never blocks indefinitely.
        """
        for queue in self._queues:
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(item)

    def publish_nowait(self, item: T) -> None:
        """Publish an item to all subscription queues without waiting.

        If a subscriber's queue is full, the oldest item is dropped.
        """
        for queue in self._queues:
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(item)

    def shutdown(self, immediate: bool = False) -> None:
        """Close all subscription queues."""
        for queue in self._queues:
            queue.shutdown(immediate=immediate)
        self._queues.clear()
