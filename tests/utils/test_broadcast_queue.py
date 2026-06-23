import asyncio

import pytest

from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.utils.broadcast import BroadcastQueue


async def test_basic_publish_subscribe():
    """Test basic publish/subscribe functionality."""
    broadcast = BroadcastQueue()
    queue1 = broadcast.subscribe()
    queue2 = broadcast.subscribe()

    await broadcast.publish("test_message")

    assert await queue1.get() == "test_message"
    assert await queue2.get() == "test_message"


async def test_publish_nowait():
    """Test publish_nowait publishes immediately without blocking."""
    broadcast = BroadcastQueue()
    queue = broadcast.subscribe()

    broadcast.publish_nowait("fast_message")

    assert await queue.get() == "fast_message"


async def test_unsubscribe():
    """Test that unsubscribed queues don't receive messages."""
    broadcast = BroadcastQueue()
    queue1 = broadcast.subscribe()
    queue2 = broadcast.subscribe()

    broadcast.unsubscribe(queue2)
    await broadcast.publish("only_for_queue1")

    assert await queue1.get() == "only_for_queue1"
    assert queue2.qsize() == 0


async def test_multiple_subscribers_receive_same_message():
    """Test all subscribers receive the same message."""
    broadcast = BroadcastQueue()
    queues = [broadcast.subscribe() for _ in range(5)]

    test_msg = {"type": "test", "data": [1, 2, 3]}
    await broadcast.publish(test_msg)

    results = await asyncio.gather(*(q.get() for q in queues))
    assert all(result == test_msg for result in results)


async def test_shutdown():
    """Test shutdown closes all queues."""
    broadcast = BroadcastQueue()
    queue1 = broadcast.subscribe()
    queue2 = broadcast.subscribe()

    broadcast.shutdown()

    with pytest.raises(QueueShutDown):
        queue1.get_nowait()
    with pytest.raises(QueueShutDown):
        queue2.get_nowait()
    assert len(broadcast._queues) == 0


async def test_publish_to_empty_queue():
    """Test publishing when no subscribers doesn't throw error."""
    broadcast = BroadcastQueue()

    # Should not raise any exception
    await broadcast.publish("no_subscribers")
    broadcast.publish_nowait("no_subscribers")


async def test_publish_nowait_skips_full_subscriber():
    """publish_nowait skips a full subscriber but continues to others."""
    broadcast = BroadcastQueue(maxsize=2)
    bounded = broadcast.subscribe()
    unbounded = broadcast.subscribe(maxsize=0)

    broadcast.publish_nowait("msg_1")
    broadcast.publish_nowait("msg_2")
    assert bounded.qsize() == 2
    assert unbounded.qsize() == 2

    # bounded is full, but unbounded should still receive msg_3.
    broadcast.publish_nowait("msg_3")
    assert bounded.qsize() == 2
    assert unbounded.qsize() == 3


async def test_default_maxsize_is_bounded():
    """Default BroadcastQueue is bounded (maxsize=1000) for production safety."""
    broadcast = BroadcastQueue()
    queue = broadcast.subscribe()
    assert queue.maxsize == 1000


async def test_graceful_shutdown_preserves_items():
    """shutdown(immediate=False) must not drop pending items from a full queue."""
    broadcast = BroadcastQueue(maxsize=3)
    queue = broadcast.subscribe()

    # Fill the queue via async publish (put) since put_nowait would skip.
    await broadcast.publish("keep_1")
    await broadcast.publish("keep_2")
    await broadcast.publish("keep_3")
    assert queue.qsize() == 3

    # Graceful shutdown should preserve the three items.
    broadcast.shutdown(immediate=False)

    assert await queue.get() == "keep_1"
    assert await queue.get() == "keep_2"
    assert await queue.get() == "keep_3"

    with pytest.raises(QueueShutDown):
        queue.get_nowait()


async def test_immediate_shutdown_clears_items():
    """shutdown(immediate=True) may drop pending items to unblock immediately."""
    broadcast = BroadcastQueue(maxsize=3)
    queue = broadcast.subscribe()

    await broadcast.publish("drop_1")
    await broadcast.publish("drop_2")
    await broadcast.publish("drop_3")

    broadcast.shutdown(immediate=True)

    with pytest.raises(QueueShutDown):
        queue.get_nowait()


async def test_publish_blocks_until_space():
    """async publish() blocks on a full queue until space is available."""
    broadcast = BroadcastQueue(maxsize=2)
    queue = broadcast.subscribe()

    broadcast.publish_nowait("old_1")
    broadcast.publish_nowait("old_2")
    assert queue.qsize() == 2

    # publish() should block until a consumer frees space.
    task = asyncio.create_task(broadcast.publish("new_msg"))
    await asyncio.sleep(0)  # let the task start and block

    assert queue.qsize() == 2  # still full
    assert await queue.get() == "old_1"

    # Now the blocked publish can proceed.
    await asyncio.wait_for(task, timeout=1.0)
    assert queue.qsize() == 2
    assert await queue.get() == "old_2"
    assert await queue.get() == "new_msg"


async def test_subscribe_with_custom_maxsize():
    """subscribe() accepts a per-subscriber maxsize."""
    broadcast = BroadcastQueue(maxsize=10)
    bounded = broadcast.subscribe()
    unbounded = broadcast.subscribe(maxsize=0)

    assert bounded.maxsize == 10
    assert unbounded.maxsize == 0


async def test_subscribe_defaults_to_broadcast_maxsize():
    """subscribe() without args uses the broadcast queue's maxsize."""
    broadcast = BroadcastQueue(maxsize=42)
    queue = broadcast.subscribe()
    assert queue.maxsize == 42
