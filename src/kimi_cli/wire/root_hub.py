from __future__ import annotations

from kimi_cli.utils.aioqueue import Queue
from kimi_cli.utils.broadcast import BroadcastQueue
from kimi_cli.wire.types import WireMessage


class RootWireHub:
    """Session-level broadcast hub for out-of-turn wire messages."""

    def __init__(self) -> None:
        # Unbounded so that waitable requests (QuestionRequest,
        # ToolCallRequest) are never dropped.
        self._queue = BroadcastQueue[WireMessage](maxsize=0)

    def subscribe(self, *, maxsize: int | None = None) -> Queue[WireMessage]:
        # Default to a bounded queue for UI consumers so slow subscribers
        # do not cause unbounded memory growth.  Critical paths (e.g.
        # the wire recorder) should pass maxsize=0 for an unbounded queue.
        if maxsize is None:
            maxsize = 1000
        return self._queue.subscribe(maxsize=maxsize)

    def unsubscribe(self, queue: Queue[WireMessage]) -> None:
        self._queue.unsubscribe(queue)

    async def publish(self, msg: WireMessage) -> None:
        await self._queue.publish(msg)

    def publish_nowait(self, msg: WireMessage) -> None:
        self._queue.publish_nowait(msg)

    def shutdown(self) -> None:
        self._queue.shutdown()
