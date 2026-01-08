"""Tests for the Shell message queue functionality."""

from __future__ import annotations

import pytest

from kimi_cli.ui.shell.queue import MessageQueue, QueueItem, QueueItemStatus


class MockUserInput:
    """Mock UserInput for testing."""

    def __init__(self, command: str):
        self.command = command
        self.mode = "agent"
        self.thinking = False
        self.content = []


@pytest.fixture
def queue() -> MessageQueue:
    """Create a fresh MessageQueue for each test."""
    return MessageQueue()


# =============================================================================
# Async API Tests
# =============================================================================


@pytest.mark.asyncio
async def test_enqueue_single_item(queue: MessageQueue):
    """Test enqueueing a single item."""
    user_input = MockUserInput("test command")
    item = await queue.enqueue(user_input)  # type: ignore

    assert item.id == 1
    assert item.user_input.command == "test command"
    assert item.status == QueueItemStatus.PENDING
    assert queue.pending_count() == 1


@pytest.mark.asyncio
async def test_enqueue_multiple_items(queue: MessageQueue):
    """Test enqueueing multiple items."""
    for i in range(3):
        await queue.enqueue(MockUserInput(f"command {i}"))  # type: ignore

    assert queue.pending_count() == 3
    items = await queue.list_pending()
    assert len(items) == 3
    assert [item.id for item in items] == [1, 2, 3]


@pytest.mark.asyncio
async def test_dequeue_single_item(queue: MessageQueue):
    """Test dequeuing a single item."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore

    item = await queue.dequeue()
    assert item is not None
    assert item.id == 1
    assert item.status == QueueItemStatus.RUNNING
    assert queue.pending_count() == 0


@pytest.mark.asyncio
async def test_dequeue_from_empty_queue(queue: MessageQueue):
    """Test dequeuing from an empty queue returns None."""
    item = await queue.dequeue()
    assert item is None


@pytest.mark.asyncio
async def test_dequeue_order(queue: MessageQueue):
    """Test that dequeue returns items in FIFO order."""
    for i in range(3):
        await queue.enqueue(MockUserInput(f"command {i}"))  # type: ignore

    item1 = await queue.dequeue()
    item2 = await queue.dequeue()
    item3 = await queue.dequeue()

    assert item1 is not None and item1.id == 1
    assert item2 is not None and item2.id == 2
    assert item3 is not None and item3.id == 3


@pytest.mark.asyncio
async def test_promote_item(queue: MessageQueue):
    """Test promoting an item to the front of the queue."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    await queue.enqueue(MockUserInput("command 2"))  # type: ignore
    await queue.enqueue(MockUserInput("command 3"))  # type: ignore

    # Promote item 3 to front
    result = await queue.promote(3)
    assert result is True

    items = await queue.list_pending()
    assert [item.id for item in items] == [3, 1, 2]


@pytest.mark.asyncio
async def test_promote_nonexistent_item(queue: MessageQueue):
    """Test promoting a non-existent item returns False."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore

    result = await queue.promote(999)
    assert result is False


@pytest.mark.asyncio
async def test_cancel_item(queue: MessageQueue):
    """Test cancelling an item in the queue."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    await queue.enqueue(MockUserInput("command 2"))  # type: ignore

    result = await queue.cancel(1)
    assert result is True

    # Item is marked as cancelled but still in queue
    items = await queue.list_pending()
    assert len(items) == 1
    assert items[0].id == 2


@pytest.mark.asyncio
async def test_cancel_nonexistent_item(queue: MessageQueue):
    """Test cancelling a non-existent item returns False."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore

    result = await queue.cancel(999)
    assert result is False


@pytest.mark.asyncio
async def test_dequeue_skips_cancelled_items(queue: MessageQueue):
    """Test that dequeue skips cancelled items."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    await queue.enqueue(MockUserInput("command 2"))  # type: ignore

    await queue.cancel(1)

    item = await queue.dequeue()
    assert item is not None
    assert item.id == 2


@pytest.mark.asyncio
async def test_clear_queue(queue: MessageQueue):
    """Test clearing all items from the queue."""
    for i in range(5):
        await queue.enqueue(MockUserInput(f"command {i}"))  # type: ignore

    count = await queue.clear()
    assert count == 5
    assert queue.pending_count() == 0


@pytest.mark.asyncio
async def test_clear_empty_queue(queue: MessageQueue):
    """Test clearing an empty queue."""
    count = await queue.clear()
    assert count == 0


@pytest.mark.asyncio
async def test_has_pending(queue: MessageQueue):
    """Test has_pending method."""
    assert queue.has_pending() is False

    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    assert queue.has_pending() is True

    await queue.dequeue()
    assert queue.has_pending() is False


@pytest.mark.asyncio
async def test_len(queue: MessageQueue):
    """Test __len__ method."""
    assert len(queue) == 0

    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    assert len(queue) == 1

    await queue.enqueue(MockUserInput("command 2"))  # type: ignore
    assert len(queue) == 2

    await queue.dequeue()
    assert len(queue) == 1


@pytest.mark.asyncio
async def test_queue_item_preview():
    """Test QueueItem preview property."""
    user_input = MockUserInput("a" * 100)
    item = QueueItem(id=1, user_input=user_input)  # type: ignore

    preview = item.preview
    assert len(preview) <= 63  # 60 chars + "..."
    assert preview.endswith("...")


@pytest.mark.asyncio
async def test_queue_item_str():
    """Test QueueItem __str__ method."""
    user_input = MockUserInput("test command")
    item = QueueItem(id=42, user_input=user_input)  # type: ignore

    assert str(item) == "[42] test command"


@pytest.mark.asyncio
async def test_id_counter_increments(queue: MessageQueue):
    """Test that ID counter increments properly."""
    item1 = await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    item2 = await queue.enqueue(MockUserInput("command 2"))  # type: ignore

    await queue.clear()

    # IDs should continue incrementing after clear
    item3 = await queue.enqueue(MockUserInput("command 3"))  # type: ignore

    assert item1.id == 1
    assert item2.id == 2
    assert item3.id == 3


# =============================================================================
# Sync API Tests
# =============================================================================


def test_enqueue_sync(queue: MessageQueue):
    """Test synchronous enqueue."""
    user_input = MockUserInput("sync command")
    item = queue.enqueue_sync(user_input)  # type: ignore

    assert item.id == 1
    assert item.user_input.command == "sync command"
    assert item.status == QueueItemStatus.PENDING
    assert queue.pending_count() == 1


def test_enqueue_sync_multiple(queue: MessageQueue):
    """Test synchronous enqueue with multiple items."""
    item1 = queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    item2 = queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
    item3 = queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

    assert item1.id == 1
    assert item2.id == 2
    assert item3.id == 3
    assert queue.pending_count() == 3

    # Verify order
    pending = queue.list_pending_sync()
    assert len(pending) == 3
    assert pending[0].id == 1
    assert pending[1].id == 2
    assert pending[2].id == 3


def test_promote_sync(queue: MessageQueue):
    """Test synchronous promote."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

    # Verify initial order
    assert [item.id for item in queue.list_pending_sync()] == [1, 2, 3]

    # Promote item 3 to front
    result = queue.promote_sync(3)
    assert result is True

    # Verify new order
    pending = queue.list_pending_sync()
    assert [item.id for item in pending] == [3, 1, 2]


def test_promote_sync_nonexistent(queue: MessageQueue):
    """Test synchronous promote with non-existent item."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

    result = queue.promote_sync(999)
    assert result is False

    # Queue unchanged
    assert queue.pending_count() == 1


def test_promote_sync_cancelled_item(queue: MessageQueue):
    """Test synchronous promote with cancelled item returns False."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

    # Cancel item 1
    queue.cancel_sync(1)

    # Try to promote cancelled item
    result = queue.promote_sync(1)
    assert result is False


def test_cancel_sync(queue: MessageQueue):
    """Test synchronous cancel."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

    result = queue.cancel_sync(1)
    assert result is True

    # Item 1 should not appear in pending list
    pending = queue.list_pending_sync()
    assert len(pending) == 1
    assert pending[0].id == 2


def test_cancel_sync_nonexistent(queue: MessageQueue):
    """Test synchronous cancel with non-existent item."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

    result = queue.cancel_sync(999)
    assert result is False

    # Queue unchanged
    assert queue.pending_count() == 1


def test_cancel_sync_already_cancelled(queue: MessageQueue):
    """Test synchronous cancel with already cancelled item returns False."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

    # First cancel succeeds
    result1 = queue.cancel_sync(1)
    assert result1 is True

    # Second cancel fails (item already cancelled)
    result2 = queue.cancel_sync(1)
    assert result2 is False


def test_clear_sync(queue: MessageQueue):
    """Test synchronous clear."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

    assert queue.pending_count() == 3

    count = queue.clear_sync()
    assert count == 3
    assert queue.pending_count() == 0
    assert queue.has_pending() is False


def test_clear_sync_empty(queue: MessageQueue):
    """Test synchronous clear on empty queue."""
    count = queue.clear_sync()
    assert count == 0


def test_clear_sync_with_cancelled_items(queue: MessageQueue):
    """Test synchronous clear counts only pending items."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

    # Cancel one item
    queue.cancel_sync(2)

    # Clear should report 2 pending items cleared
    count = queue.clear_sync()
    assert count == 2


def test_list_pending_sync(queue: MessageQueue):
    """Test synchronous list_pending."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

    pending = queue.list_pending_sync()
    assert len(pending) == 2
    assert pending[0].user_input.command == "command 1"
    assert pending[1].user_input.command == "command 2"


def test_list_pending_sync_excludes_cancelled(queue: MessageQueue):
    """Test synchronous list_pending excludes cancelled items."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

    queue.cancel_sync(2)

    pending = queue.list_pending_sync()
    assert len(pending) == 2
    assert pending[0].id == 1
    assert pending[1].id == 3


# =============================================================================
# Mixed Async/Sync Tests
# =============================================================================


@pytest.mark.asyncio
async def test_sync_enqueue_async_dequeue(queue: MessageQueue):
    """Test sync enqueue followed by async dequeue."""
    queue.enqueue_sync(MockUserInput("sync item"))  # type: ignore

    item = await queue.dequeue()
    assert item is not None
    assert item.user_input.command == "sync item"
    assert item.status == QueueItemStatus.RUNNING


@pytest.mark.asyncio
async def test_async_enqueue_sync_operations(queue: MessageQueue):
    """Test async enqueue followed by sync operations."""
    await queue.enqueue(MockUserInput("async item 1"))  # type: ignore
    await queue.enqueue(MockUserInput("async item 2"))  # type: ignore
    await queue.enqueue(MockUserInput("async item 3"))  # type: ignore

    # Sync promote
    result = queue.promote_sync(3)
    assert result is True
    assert queue.list_pending_sync()[0].id == 3

    # Sync cancel
    result = queue.cancel_sync(1)
    assert result is True
    assert len(queue.list_pending_sync()) == 2

    # Sync clear
    count = queue.clear_sync()
    assert count == 2


# =============================================================================
# Edge Cases
# =============================================================================


def test_queue_item_preview_short_command():
    """Test QueueItem preview with short command."""
    user_input = MockUserInput("short")
    item = QueueItem(id=1, user_input=user_input)  # type: ignore

    preview = item.preview
    assert preview == "short"
    assert "..." not in preview


def test_queue_item_preview_exact_60_chars():
    """Test QueueItem preview with exactly 60 characters."""
    user_input = MockUserInput("a" * 60)
    item = QueueItem(id=1, user_input=user_input)  # type: ignore

    preview = item.preview
    assert preview == "a" * 60
    assert "..." not in preview


def test_queue_item_preview_61_chars():
    """Test QueueItem preview with 61 characters (triggers truncation)."""
    user_input = MockUserInput("a" * 61)
    item = QueueItem(id=1, user_input=user_input)  # type: ignore

    preview = item.preview
    assert preview == "a" * 60 + "..."
    assert len(preview) == 63


def test_queue_item_str_truncation():
    """Test QueueItem __str__ with long command."""
    user_input = MockUserInput("b" * 100)
    item = QueueItem(id=1, user_input=user_input)  # type: ignore

    s = str(item)
    assert s == "[1] " + "b" * 50 + "..."
    assert len(s) == 4 + 50 + 3  # "[1] " + 50 chars + "..."


@pytest.mark.asyncio
async def test_promote_first_item_is_noop(queue: MessageQueue):
    """Test promoting the first item has no effect on order."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    await queue.enqueue(MockUserInput("command 2"))  # type: ignore

    result = await queue.promote(1)
    assert result is True

    items = await queue.list_pending()
    assert [item.id for item in items] == [1, 2]


@pytest.mark.asyncio
async def test_dequeue_all_cancelled(queue: MessageQueue):
    """Test dequeue when all items are cancelled returns None."""
    await queue.enqueue(MockUserInput("command 1"))  # type: ignore
    await queue.enqueue(MockUserInput("command 2"))  # type: ignore

    await queue.cancel(1)
    await queue.cancel(2)

    item = await queue.dequeue()
    assert item is None


def test_pending_count_accuracy(queue: MessageQueue):
    """Test pending_count reflects only PENDING status items."""
    queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
    queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore
    assert queue.pending_count() == 3

    # Cancel one
    queue.cancel_sync(2)
    assert queue.pending_count() == 2

    # Cancel another
    queue.cancel_sync(1)
    assert queue.pending_count() == 1

    # Cancel last
    queue.cancel_sync(3)
    assert queue.pending_count() == 0
