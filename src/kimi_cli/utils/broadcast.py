import asyncio
import contextlib

from kimi_cli.utils.aioqueue import Queue


class BroadcastQueue[T]:
    """A broadcast queue that allows multiple subscribers to receive published items.

    Each subscriber gets its own queue.  By default queues are bounded
    (``maxsize=1000``) to prevent unbounded memory growth; an unbounded
    queue can be requested with ``maxsize=0``.  Critical consumers
    (e.g. wire recorders and waitable request paths) should use an
    unbounded queue.
    """

    def __init__(self, *, maxsize: int = 1000) -> None:
        self._queues: set[Queue[T]] = set()
        self._maxsize = maxsize

    def subscribe(self, *, maxsize: int | None = None) -> Queue[T]:
        """Create a new subscription queue.

        Args:
            maxsize: Maximum queue size.  ``None`` uses the broadcast
                queue's default (unbounded).  ``0`` means unbounded.
                Pass a positive value for lossy consumers that may fall
                behind and can tolerate dropped messages.
        """
        queue: Queue[T] = Queue(maxsize=maxsize if maxsize is not None else self._maxsize)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: Queue[T]) -> None:
        """Remove a subscription queue."""
        self._queues.discard(queue)

    async def publish(self, item: T) -> None:
        """Publish an item to all subscription queues, awaiting space.

        This blocks until every subscriber has room for the item.
        """
        for queue in self._queues:
            await queue.put(item)

    def publish_nowait(self, item: T) -> None:
        """Publish an item to all subscription queues without waiting.

        If a single subscriber's queue is full, that subscriber is
        skipped so that later subscribers still receive the item.
        Callers that require guaranteed delivery (e.g. waitable
        requests) should use an unbounded queue so no subscriber is
        ever skipped.
        """
        for queue in self._queues:
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(item)

    def shutdown(self, immediate: bool = False) -> None:
        """Close all subscription queues."""
        for queue in self._queues:
            queue.shutdown(immediate=immediate)
        self._queues.clear()
