"""Tests for _BackgroundCompletionWatcher in the shell main loop."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from kimi_cli.ui.shell import _BackgroundCompletionWatcher, _PromptEvent


def _make_watcher(
    *,
    has_pending: bool = False,
) -> _BackgroundCompletionWatcher:
    """Build a watcher with mocked internals (no real Soul needed)."""
    watcher = _BackgroundCompletionWatcher.__new__(_BackgroundCompletionWatcher)
    watcher._event = asyncio.Event()
    watcher._notifications = MagicMock()
    watcher._notifications.has_pending_for_sink.return_value = has_pending
    return watcher


# -------------------------------------------------------------------
# Early-return path: pending notifications exist before waiting
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pending_notification_and_empty_queue_returns_none():
    """Pending LLM notification + empty queue → return None (trigger agent)."""
    watcher = _make_watcher(has_pending=True)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    result = await watcher.wait_for_next(queue)
    assert result is None


@pytest.mark.asyncio
async def test_pending_notification_but_user_input_queued_returns_event():
    """Pending LLM notification + queued user input → user input wins."""
    watcher = _make_watcher(has_pending=True)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    event = _PromptEvent(kind="input")
    await queue.put(event)

    result = await watcher.wait_for_next(queue)
    assert result is event


@pytest.mark.asyncio
async def test_pending_notification_but_eof_queued_returns_eof():
    """Pending notification + queued EOF → user can still exit."""
    watcher = _make_watcher(has_pending=True)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    eof = _PromptEvent(kind="eof")
    await queue.put(eof)

    result = await watcher.wait_for_next(queue)
    assert result is eof


# -------------------------------------------------------------------
# Event-based path: background event fires while waiting
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bg_event_fires_with_pending_returns_none():
    """Background event fires + pending notification → return None."""
    watcher = _make_watcher()
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    async def _set_event():
        await asyncio.sleep(0)
        mock = watcher._notifications
        assert isinstance(mock, MagicMock)
        mock.has_pending_for_sink.return_value = True
        assert watcher._event is not None
        watcher._event.set()

    asyncio.create_task(_set_event())
    result = await watcher.wait_for_next(queue)
    assert result is None


@pytest.mark.asyncio
async def test_bg_event_fires_no_pending_returns_noop():
    """Background event fires but no pending notification → bg_noop."""
    watcher = _make_watcher()
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    async def _set_event():
        await asyncio.sleep(0)
        assert watcher._event is not None
        watcher._event.set()

    asyncio.create_task(_set_event())
    result = await watcher.wait_for_next(queue)
    assert result is not None
    assert result.kind == "bg_noop"


@pytest.mark.asyncio
async def test_user_input_wins_over_simultaneous_bg_event():
    """Both idle and bg fire simultaneously → user input takes priority."""
    watcher = _make_watcher()
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    event = _PromptEvent(kind="input")

    # Both ready before await
    await queue.put(event)
    assert watcher._event is not None
    watcher._event.set()

    result = await watcher.wait_for_next(queue)
    assert result is event


# -------------------------------------------------------------------
# Disabled watcher: non-KimiSoul path
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disabled_watcher_just_awaits_idle():
    """When watcher is disabled (no KimiSoul), it behaves as plain get()."""
    watcher = _BackgroundCompletionWatcher.__new__(_BackgroundCompletionWatcher)
    watcher._event = None
    watcher._notifications = None
    assert not watcher.enabled

    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    event = _PromptEvent(kind="input")
    await queue.put(event)

    result = await watcher.wait_for_next(queue)
    assert result is event
