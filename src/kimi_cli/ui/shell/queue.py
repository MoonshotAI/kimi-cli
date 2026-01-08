"""
Message queue for Shell UI.

Allows users to submit new questions while the current inference is still running.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from enum import Enum, auto
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kimi_cli.ui.shell.prompt import UserInput


class QueueItemStatus(Enum):
    """Status of a queue item."""

    PENDING = auto()
    RUNNING = auto()
    CANCELLED = auto()


@dataclass
class QueueItem:
    """A task item in the message queue."""

    id: int
    user_input: UserInput
    status: QueueItemStatus = QueueItemStatus.PENDING

    def __str__(self) -> str:
        cmd = self.user_input.command
        preview = cmd[:50] + "..." if len(cmd) > 50 else cmd
        return f"[{self.id}] {preview}"

    @property
    def preview(self) -> str:
        """Get a short preview of the command."""
        cmd = self.user_input.command
        return cmd[:60] + "..." if len(cmd) > 60 else cmd


class MessageQueue:
    """
    Message queue manager for Shell UI.

    Thread-safe, supports async operations for adding new messages
    while inference is running.
    """

    def __init__(self) -> None:
        self._queue: deque[QueueItem] = deque()
        self._id_counter: int = 0
        self._lock = asyncio.Lock()
        self._new_item_event = asyncio.Event()

    async def enqueue(self, user_input: UserInput) -> QueueItem:
        """Add a new message to the end of the queue."""
        async with self._lock:
            self._id_counter += 1
            item = QueueItem(id=self._id_counter, user_input=user_input)
            self._queue.append(item)
            self._new_item_event.set()
            return item

    def enqueue_sync(self, user_input: UserInput) -> QueueItem:
        """Add a new message to the end of the queue (sync, for UI thread)."""
        self._id_counter += 1
        item = QueueItem(id=self._id_counter, user_input=user_input)
        self._queue.append(item)
        self._new_item_event.set()
        return item

    async def dequeue(self) -> QueueItem | None:
        """
        Remove and return the first pending message from the queue.

        Returns None if the queue is empty or has no pending items.
        """
        async with self._lock:
            while self._queue:
                item = self._queue.popleft()
                if item.status == QueueItemStatus.PENDING:
                    item.status = QueueItemStatus.RUNNING
                    if not self._queue:
                        self._new_item_event.clear()
                    return item
            self._new_item_event.clear()
            return None

    async def promote(self, item_id: int) -> bool:
        """Move the specified item to the front of the queue."""
        async with self._lock:
            return self._promote_sync(item_id)

    def promote_sync(self, item_id: int) -> bool:
        """Move the specified item to the front of the queue (sync)."""
        return self._promote_sync(item_id)

    def _promote_sync(self, item_id: int) -> bool:
        for item in self._queue:
            if item.id == item_id and item.status == QueueItemStatus.PENDING:
                self._queue.remove(item)
                self._queue.appendleft(item)
                return True
        return False

    async def cancel(self, item_id: int) -> bool:
        """Cancel the specified item in the queue."""
        async with self._lock:
            return self._cancel_sync(item_id)

    def cancel_sync(self, item_id: int) -> bool:
        """Cancel the specified item in the queue (sync)."""
        return self._cancel_sync(item_id)

    def _cancel_sync(self, item_id: int) -> bool:
        for item in self._queue:
            if item.id == item_id and item.status == QueueItemStatus.PENDING:
                item.status = QueueItemStatus.CANCELLED
                return True
        return False

    async def clear(self) -> int:
        """Clear all pending items from the queue."""
        async with self._lock:
            return self._clear_sync()

    def clear_sync(self) -> int:
        """Clear all pending items from the queue (sync)."""
        return self._clear_sync()

    def _clear_sync(self) -> int:
        count = sum(1 for i in self._queue if i.status == QueueItemStatus.PENDING)
        self._queue.clear()
        self._new_item_event.clear()
        return count

    async def list_pending(self) -> list[QueueItem]:
        """List all pending items in the queue."""
        async with self._lock:
            return [i for i in self._queue if i.status == QueueItemStatus.PENDING]

    def list_pending_sync(self) -> list[QueueItem]:
        """List all pending items in the queue (non-async for UI display)."""
        return [i for i in self._queue if i.status == QueueItemStatus.PENDING]

    def pending_count(self) -> int:
        """Get the count of pending items (non-async for UI display)."""
        return sum(1 for i in self._queue if i.status == QueueItemStatus.PENDING)

    def __len__(self) -> int:
        """Return the number of pending items."""
        return self.pending_count()

    async def wait_for_new_item(self) -> None:
        """Wait until a new item is added to the queue."""
        await self._new_item_event.wait()

    def has_pending(self) -> bool:
        """Check if there are any pending items (non-async)."""
        return any(i.status == QueueItemStatus.PENDING for i in self._queue)
