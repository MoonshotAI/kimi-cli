"""Tests for _BackgroundCompletionWatcher in the shell main loop."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock

import pytest

from kimi_cli.soul import Soul
from kimi_cli.ui.shell import Shell, _BackgroundCompletionWatcher, _PromptEvent


def _make_watcher(
    *,
    has_pending: bool = False,
    can_auto_trigger_pending: bool = True,
) -> _BackgroundCompletionWatcher:
    """Build a watcher with mocked internals (no real Soul needed)."""
    watcher = _BackgroundCompletionWatcher.__new__(_BackgroundCompletionWatcher)
    watcher._event = asyncio.Event()
    watcher._notifications = MagicMock()
    watcher._notifications.has_pending_for_sink.return_value = has_pending
    watcher._can_auto_trigger_pending = lambda: can_auto_trigger_pending
    return watcher


# -------------------------------------------------------------------
# Early-return path: pending notifications exist before waiting
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pending_notification_and_empty_queue_waits_for_user_input():
    """Pending LLM notification alone should not auto-trigger the agent."""
    watcher = _make_watcher(has_pending=True, can_auto_trigger_pending=False)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    task = asyncio.create_task(watcher.wait_for_next(queue))
    await asyncio.sleep(0)
    assert task.done() is False

    event = _PromptEvent(kind="input")
    await queue.put(event)
    result = await task
    assert result is event


@pytest.mark.asyncio
async def test_pending_notification_but_user_input_queued_returns_event():
    """Pending LLM notification + queued user input → user input wins."""
    watcher = _make_watcher(has_pending=True, can_auto_trigger_pending=False)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    event = _PromptEvent(kind="input")
    await queue.put(event)

    result = await watcher.wait_for_next(queue)
    assert result is event


@pytest.mark.asyncio
async def test_pending_notification_but_eof_queued_returns_eof():
    """Pending notification + queued EOF → user can still exit."""
    watcher = _make_watcher(has_pending=True, can_auto_trigger_pending=False)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    eof = _PromptEvent(kind="eof")
    await queue.put(eof)

    result = await watcher.wait_for_next(queue)
    assert result is eof


@pytest.mark.asyncio
async def test_pending_notification_auto_triggers_once_shell_is_armed():
    """After the first user-triggered turn, pending LLM notifications can auto-trigger."""
    watcher = _make_watcher(has_pending=True, can_auto_trigger_pending=True)
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    result = await watcher.wait_for_next(queue)
    assert result is None


# -------------------------------------------------------------------
# Event-based path: background event fires while waiting
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bg_event_fires_with_pending_returns_none():
    """A fresh background completion with pending LLM notification should auto-trigger."""
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
async def test_bg_event_with_pending_returns_noop_before_shell_is_armed():
    """Before the first user turn after resume, fresh completions should not auto-trigger."""
    watcher = _make_watcher(has_pending=False, can_auto_trigger_pending=False)
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
    assert result is not None
    assert result.kind == "bg_noop"


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


class _FakePromptActivity:
    def __init__(
        self,
        *,
        pending: bool = False,
        recent: bool = False,
        remaining: float = 0.0,
    ) -> None:
        self._pending = pending
        self._recent = recent
        self._remaining = remaining
        self._event = asyncio.Event()

    def has_pending_input(self) -> bool:
        return self._pending

    def had_recent_input_activity(self, *, within_s: float) -> bool:
        return self._recent

    def recent_input_activity_remaining(self, *, within_s: float) -> float:
        return self._remaining

    async def wait_for_input_activity(self) -> None:
        await self._event.wait()
        self._event.clear()


def test_shell_defers_background_auto_trigger_when_buffer_non_empty() -> None:
    prompt = _FakePromptActivity(pending=True, recent=False)
    assert Shell._should_defer_background_auto_trigger(prompt) is True


def test_shell_defers_background_auto_trigger_when_recent_input_activity() -> None:
    prompt = _FakePromptActivity(pending=False, recent=True)
    assert Shell._should_defer_background_auto_trigger(prompt) is True


def test_shell_uses_grace_timeout_only_for_recent_activity_without_pending_input() -> None:
    prompt = _FakePromptActivity(pending=False, recent=True, remaining=0.25)
    assert Shell._background_auto_trigger_timeout_s(prompt) == pytest.approx(0.25)

    with_pending = _FakePromptActivity(pending=True, recent=True, remaining=0.25)
    assert Shell._background_auto_trigger_timeout_s(with_pending) is None


@pytest.mark.asyncio
async def test_shell_wait_for_input_or_activity_returns_activity_event() -> None:
    shell = Shell(cast(Soul, SimpleNamespace(available_slash_commands=[], name="x")), None)
    prompt = _FakePromptActivity()
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    task = asyncio.create_task(shell._wait_for_input_or_activity(prompt, queue))
    await asyncio.sleep(0)
    prompt._event.set()

    result = await task
    assert result.kind == "input_activity"


@pytest.mark.asyncio
async def test_shell_wait_for_input_or_activity_returns_idle_event() -> None:
    shell = Shell(cast(Soul, SimpleNamespace(available_slash_commands=[], name="x")), None)
    prompt = _FakePromptActivity()
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()
    expected = _PromptEvent(kind="input")

    task = asyncio.create_task(shell._wait_for_input_or_activity(prompt, queue))
    await queue.put(expected)

    result = await task
    assert result is expected


@pytest.mark.asyncio
async def test_shell_wait_for_input_or_activity_times_out_for_recent_activity_only() -> None:
    shell = Shell(cast(Soul, SimpleNamespace(available_slash_commands=[], name="x")), None)
    prompt = _FakePromptActivity()
    queue: asyncio.Queue[_PromptEvent] = asyncio.Queue()

    started = asyncio.get_running_loop().time()
    result = await shell._wait_for_input_or_activity(prompt, queue, timeout_s=0.05)
    elapsed = asyncio.get_running_loop().time() - started

    assert result.kind == "input_activity"
    assert elapsed >= 0.04
