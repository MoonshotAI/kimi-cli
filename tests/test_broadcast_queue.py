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
