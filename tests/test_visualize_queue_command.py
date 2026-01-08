"""Tests for visualize queue command handling."""

from __future__ import annotations

import pytest

from kimi_cli.ui.shell.queue import MessageQueue
from kimi_cli.ui.shell.visualize import _LiveView
from kimi_cli.wire.message import StatusUpdate


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


@pytest.fixture
def live_view(queue: MessageQueue) -> _LiveView:
    """Create a _LiveView with message queue."""
    initial_status = StatusUpdate(context_usage=0.5)
    return _LiveView(initial_status, message_queue=queue)


@pytest.fixture
def live_view_no_queue() -> _LiveView:
    """Create a _LiveView without message queue."""
    initial_status = StatusUpdate(context_usage=0.5)
    return _LiveView(initial_status, message_queue=None)


# =============================================================================
# _handle_queue_command Tests
# =============================================================================


class TestHandleQueueCommand:
    """Tests for _LiveView._handle_queue_command."""

    def test_cancel_queued_with_cq(self, live_view: _LiveView, queue: MessageQueue):
        """Test /cq command cancels item."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

        result = live_view._handle_queue_command("/cq 1")
        assert result is True

        pending = queue.list_pending_sync()
        assert len(pending) == 1
        assert pending[0].id == 2

    def test_cancel_queued_with_full_command(self, live_view: _LiveView, queue: MessageQueue):
        """Test /cancel-queued command cancels item."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

        result = live_view._handle_queue_command("/cancel-queued 2")
        assert result is True

        pending = queue.list_pending_sync()
        assert len(pending) == 1
        assert pending[0].id == 1

    def test_cancel_queued_case_insensitive(self, live_view: _LiveView, queue: MessageQueue):
        """Test /CQ command is case insensitive."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        result = live_view._handle_queue_command("/CQ 1")
        assert result is True
        assert queue.pending_count() == 0

    def test_cancel_queued_nonexistent_returns_true(
        self, live_view: _LiveView, queue: MessageQueue
    ):
        """Test /cq with nonexistent id still returns True (command was handled)."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        result = live_view._handle_queue_command("/cq 999")
        assert result is True
        # Queue unchanged
        assert queue.pending_count() == 1

    def test_cancel_queued_invalid_id_returns_true(
        self, live_view: _LiveView, queue: MessageQueue
    ):
        """Test /cq with invalid id format still returns True."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        result = live_view._handle_queue_command("/cq abc")
        assert result is True
        # Queue unchanged
        assert queue.pending_count() == 1

    def test_cancel_queued_missing_id_returns_true(
        self, live_view: _LiveView, queue: MessageQueue
    ):
        """Test /cq without id still returns True."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        result = live_view._handle_queue_command("/cq")
        assert result is True
        # Queue unchanged (no crash, graceful handling)
        assert queue.pending_count() == 1

    def test_promote_with_p(self, live_view: _LiveView, queue: MessageQueue):
        """Test /p command promotes item."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

        result = live_view._handle_queue_command("/p 3")
        assert result is True

        pending = queue.list_pending_sync()
        assert [item.id for item in pending] == [3, 1, 2]

    def test_promote_with_full_command(self, live_view: _LiveView, queue: MessageQueue):
        """Test /promote command promotes item."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

        result = live_view._handle_queue_command("/promote 2")
        assert result is True

        pending = queue.list_pending_sync()
        assert [item.id for item in pending] == [2, 1]

    def test_promote_case_insensitive(self, live_view: _LiveView, queue: MessageQueue):
        """Test /P command is case insensitive."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

        result = live_view._handle_queue_command("/P 2")
        assert result is True

        pending = queue.list_pending_sync()
        assert pending[0].id == 2

    def test_clear_queue_with_clearq(self, live_view: _LiveView, queue: MessageQueue):
        """Test /clearq command clears queue."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 3"))  # type: ignore

        result = live_view._handle_queue_command("/clearq")
        assert result is True
        assert queue.pending_count() == 0

    def test_clear_queue_with_full_command(self, live_view: _LiveView, queue: MessageQueue):
        """Test /clear-queue command clears queue."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

        result = live_view._handle_queue_command("/clear-queue")
        assert result is True
        assert queue.pending_count() == 0

    def test_clear_queue_case_insensitive(self, live_view: _LiveView, queue: MessageQueue):
        """Test /CLEARQ command is case insensitive."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        result = live_view._handle_queue_command("/CLEARQ")
        assert result is True
        assert queue.pending_count() == 0

    def test_clear_queue_empty(self, live_view: _LiveView, queue: MessageQueue):
        """Test /clearq on empty queue."""
        result = live_view._handle_queue_command("/clearq")
        assert result is True
        assert queue.pending_count() == 0

    def test_non_queue_command_returns_false(self, live_view: _LiveView, queue: MessageQueue):
        """Test non-queue commands return False."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        # Regular message
        result = live_view._handle_queue_command("hello world")
        assert result is False

        # Other slash command
        result = live_view._handle_queue_command("/help")
        assert result is False

        # Partial match should not work
        result = live_view._handle_queue_command("/clear")
        assert result is False

        result = live_view._handle_queue_command("/cancel")
        assert result is False

        # Queue unchanged
        assert queue.pending_count() == 1

    def test_no_queue_returns_false(self, live_view_no_queue: _LiveView):
        """Test _handle_queue_command returns False when no queue."""
        result = live_view_no_queue._handle_queue_command("/cq 1")
        assert result is False

        result = live_view_no_queue._handle_queue_command("/clearq")
        assert result is False

    def test_commands_with_extra_spaces(self, live_view: _LiveView, queue: MessageQueue):
        """Test commands with extra spaces in arguments."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore

        # Extra space after command
        result = live_view._handle_queue_command("/cq  1")
        assert result is True
        # Note: split() handles multiple spaces, so "1" is still parsed
        assert queue.pending_count() == 1

    def test_cq_with_trailing_text(self, live_view: _LiveView, queue: MessageQueue):
        """Test /cq ignores trailing text after id."""
        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore

        # Extra text after id
        result = live_view._handle_queue_command("/cq 1 extra stuff")
        assert result is True
        assert queue.pending_count() == 0


# =============================================================================
# Input Block Integration Tests
# =============================================================================


class TestInputBlockIntegration:
    """Tests for input block with queue command handling."""

    def test_input_block_exists_with_queue(self, live_view: _LiveView):
        """Test input block is created when queue is provided."""
        assert live_view._input_block is not None

    def test_input_block_none_without_queue(self, live_view_no_queue: _LiveView):
        """Test input block is None when no queue is provided."""
        assert live_view_no_queue._input_block is None

    def test_queue_block_exists(self, live_view: _LiveView):
        """Test queue block is created."""
        assert live_view._queue_block is not None

    def test_queue_block_pending_count(self, live_view: _LiveView, queue: MessageQueue):
        """Test queue block reports correct pending count."""
        assert live_view._queue_block.pending_count() == 0

        queue.enqueue_sync(MockUserInput("command 1"))  # type: ignore
        assert live_view._queue_block.pending_count() == 1

        queue.enqueue_sync(MockUserInput("command 2"))  # type: ignore
        assert live_view._queue_block.pending_count() == 2

        queue.cancel_sync(1)
        assert live_view._queue_block.pending_count() == 1
