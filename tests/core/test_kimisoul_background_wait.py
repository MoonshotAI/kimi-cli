"""Tests for Print mode background task waiting behavior.

When background agents are still running after ``run_soul()`` completes a turn,
**text** (one-shot) print mode should:

- drive ``reconcile()`` each iteration (the notification pump inside ``run_soul``
  is no longer running, so we must recover lost workers and publish terminal
  notifications ourselves);
- re-enter the soul whenever ``has_pending_for_sink("llm")`` is True — even if
  other tasks are still active — so per-task progress is not blocked by
  long-running siblings;
- keep polling until both ``has_active_tasks()`` and ``has_pending_for_sink``
  are False;
- skip the wait loop entirely in ``stream-json`` mode (multi-turn) so
  background tasks from one command do not block the next command;
- raise ``RunCancelled`` when ``cancel_event`` is set.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kimi_cli.cli import ExitCode, InputFormat
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.print import Print


class _FakeState:
    """Mutable state that drives has_active_tasks / has_pending_for_sink."""

    def __init__(self, *, active: bool = False, pending: bool = False):
        self.active = active
        self.pending = pending
        self.reconcile_count = 0


def _wire_manager(state: _FakeState) -> tuple[MagicMock, MagicMock]:
    manager = MagicMock()
    manager.has_active_tasks = MagicMock(side_effect=lambda: state.active)

    def _reconcile():
        state.reconcile_count += 1

    manager.reconcile = MagicMock(side_effect=_reconcile)

    notifications = MagicMock()
    notifications.has_pending_for_sink = MagicMock(side_effect=lambda sink: state.pending)
    return manager, notifications


def _make_print_with_runtime(
    tmp_path: Path,
    manager: MagicMock,
    notifications: MagicMock,
    *,
    input_format: InputFormat = "text",
) -> tuple[Print, AsyncMock]:
    soul = AsyncMock(spec=KimiSoul)
    soul.runtime = MagicMock()
    soul.runtime.role = "root"
    soul.runtime.background_tasks = manager
    soul.runtime.notifications = notifications
    soul.runtime.session.wire_file = tmp_path / "wire.jsonl"

    p = Print(
        soul=soul,
        input_format=input_format,
        output_format="text",
        context_file=tmp_path / "context.json",
    )
    return p, soul


# ---------------------------------------------------------------------------
# Core: wait → pending → re-enter soul
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_reruns_soul_on_pending_notification(tmp_path: Path) -> None:
    """After run_soul, if tasks complete and create pending LLM notifications,
    Print should re-enter run_soul with a system-reminder prompt."""
    state = _FakeState(active=True, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)
    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 1:
            # Simulate a worker finishing + reconcile publishing a notification
            state.active = False
            state.pending = True
        else:
            # Re-entry drains the pending notification (like real deliver_pending)
            state.pending = False

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await p.run(command="do work")

    assert code == ExitCode.SUCCESS
    assert len(run_soul_calls) == 2
    assert run_soul_calls[0] == "do work"
    assert "<system-reminder>" in run_soul_calls[1]
    assert state.reconcile_count >= 1


# ---------------------------------------------------------------------------
# reconcile() is called on every poll iteration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_calls_reconcile_each_poll_iteration(tmp_path: Path) -> None:
    """reconcile() must be called on every poll iteration."""
    state = _FakeState(active=True, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)
    call_count = 0

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        nonlocal call_count
        call_count += 1

    # Patch sleep to also decrement a poll counter so the test finishes fast
    poll_counter = {"n": 0}
    real_sleep = asyncio.sleep

    async def fake_sleep(duration):
        poll_counter["n"] += 1
        if poll_counter["n"] >= 3:
            state.active = False
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
    ):
        await p.run(command="test")

    # Before each sleep there is a reconcile call (and one final reconcile
    # after the last sleep).  Expect at least 3 reconciles.
    assert state.reconcile_count >= 3


# ---------------------------------------------------------------------------
# No re-entry when no notifications are pending
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_skips_reentry_when_no_pending_notifications(tmp_path: Path) -> None:
    """If tasks complete but there are no pending LLM notifications, the soul
    should NOT be re-entered."""
    state = _FakeState(active=True, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)
    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    real_sleep = asyncio.sleep

    async def fake_sleep(duration):
        state.active = False
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
    ):
        code = await p.run(command="hello")

    assert code == ExitCode.SUCCESS
    assert len(run_soul_calls) == 1


# ---------------------------------------------------------------------------
# Pre-existing pending notifications: tasks already done before first check
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_reruns_soul_when_tasks_done_but_notifications_pending(
    tmp_path: Path,
) -> None:
    """If all tasks finished before the first check and reconcile publishes
    notifications, the soul should still be re-entered to drain them."""
    state = _FakeState(active=False, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)
    run_soul_calls: list[str] = []
    reconcile_original = manager.reconcile.side_effect

    def reconcile_then_publish():
        reconcile_original()
        # First reconcile: publish a pending notification
        if state.reconcile_count == 1:
            state.pending = True

    manager.reconcile.side_effect = reconcile_then_publish

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) > 1:
            state.pending = False

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await p.run(command="trigger")

    assert code == ExitCode.SUCCESS
    assert len(run_soul_calls) == 2
    assert "<system-reminder>" in run_soul_calls[1]


# ---------------------------------------------------------------------------
# Empty: no tasks, no pending → no wait, exit immediately
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_exits_normally_when_no_background_work(tmp_path: Path) -> None:
    """No active tasks and no pending notifications → exit without waiting."""
    state = _FakeState(active=False, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)
    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await p.run(command="hello")

    assert code == ExitCode.SUCCESS
    assert len(run_soul_calls) == 1
    # Two reconciles: one at the top of the loop, one final double-check
    # before break (to catch workers that finish between the two snapshots).
    assert state.reconcile_count == 2


# ---------------------------------------------------------------------------
# stream-json mode: must NOT block between commands
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_stream_json_does_not_wait_for_background_tasks(
    tmp_path: Path,
) -> None:
    """In stream-json mode the wait loop must be skipped entirely."""
    state = _FakeState(active=True, pending=True)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications, input_format="stream-json")
    run_soul_calls: list[str] = []
    read_count = 0

    def fake_read_next_command():
        nonlocal read_count
        read_count += 1
        if read_count == 1:
            return "second command"
        return None

    p._read_next_command = fake_read_next_command

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await p.run(command="first command")

    assert code == ExitCode.SUCCESS
    assert run_soul_calls == ["first command", "second command"]
    # reconcile must NOT be called in stream-json mode
    assert state.reconcile_count == 0


# ---------------------------------------------------------------------------
# Cancellation → FAILURE, not SUCCESS
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_background_wait_cancel_returns_failure(tmp_path: Path) -> None:
    """Ctrl+C during background wait should exit and return FAILURE."""
    state = _FakeState(active=True, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        pass

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.install_sigint_handler") as mock_sigint,
    ):
        cancel_handler = None

        def capture_handler(loop, handler):
            nonlocal cancel_handler
            cancel_handler = handler
            return lambda: None

        mock_sigint.side_effect = capture_handler

        async def run_with_cancel():
            task = asyncio.create_task(p.run(command="test"))
            await asyncio.sleep(0.05)
            if cancel_handler:
                cancel_handler()
            return await asyncio.wait_for(task, timeout=5.0)

        code = await run_with_cancel()

    assert code == ExitCode.FAILURE


# ---------------------------------------------------------------------------
# Re-entry with sibling tasks still running (P1 scenario 2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_reruns_soul_even_with_active_sibling_tasks(
    tmp_path: Path,
) -> None:
    """When one task finishes and publishes a notification while another is
    still active, the re-entry must happen immediately — completed-task
    progress must not wait on siblings."""
    state = _FakeState(active=True, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications)
    run_soul_calls: list[str] = []

    reconcile_original = manager.reconcile.side_effect

    def reconcile_then_publish():
        reconcile_original()
        # First reconcile: publish notification for completed sibling,
        # other task still running.
        if state.reconcile_count == 1:
            state.pending = True

    manager.reconcile.side_effect = reconcile_then_publish

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 2:
            # Re-entry: ack the pending notification and finish the sibling
            state.pending = False
            state.active = False

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await p.run(command="siblings")

    assert code == ExitCode.SUCCESS
    # Re-entry happened even though active=True at that moment
    assert len(run_soul_calls) == 2
