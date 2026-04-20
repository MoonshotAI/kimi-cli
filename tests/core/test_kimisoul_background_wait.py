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
from kimi_cli.soul import RunCancelled
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.print import Print


class _FakeState:
    """Mutable state that drives has_active_tasks / has_pending_for_sink."""

    def __init__(
        self,
        *,
        active: bool = False,
        pending: bool = False,
        active_views: list[MagicMock] | None = None,
    ):
        self.active = active
        self.pending = pending
        self.reconcile_count = 0
        self.active_views: list[MagicMock] = list(active_views or [])
        self.kill_reasons: list[str] = []


def _fake_view(
    task_id: str,
    description: str = "desc",
    *,
    timeout_s: int | None = None,
    status: str = "running",
    kill_requested_at: float | None = None,
) -> MagicMock:
    view = MagicMock()
    view.spec.id = task_id
    view.spec.description = description
    view.spec.timeout_s = timeout_s
    view.runtime.status = status
    # Must pin to a real None — without this MagicMock auto-creates a
    # truthy child mock, and ``control.kill_requested_at is not None``
    # would always be True in production-code path checks.
    view.control.kill_requested_at = kill_requested_at
    return view


def _wire_manager(state: _FakeState) -> tuple[MagicMock, MagicMock]:
    manager = MagicMock()
    manager.has_active_tasks = MagicMock(
        side_effect=lambda: state.active or bool(state.active_views)
    )

    def _reconcile():
        state.reconcile_count += 1

    manager.reconcile = MagicMock(side_effect=_reconcile)

    def _list_tasks(*, status=None, limit=None):
        return list(state.active_views)

    manager.list_tasks = MagicMock(side_effect=_list_tasks)

    def _kill_all_active(*, reason: str = "Killed") -> list[str]:
        state.kill_reasons.append(reason)
        ids = [v.spec.id for v in state.active_views]
        state.active_views = []
        state.active = False
        return ids

    manager.kill_all_active = MagicMock(side_effect=_kill_all_active)

    notifications = MagicMock()
    notifications.has_pending_for_sink = MagicMock(side_effect=lambda sink: state.pending)
    return manager, notifications


def _make_print_with_runtime(
    tmp_path: Path,
    manager: MagicMock,
    notifications: MagicMock,
    *,
    input_format: InputFormat = "text",
    keep_alive_on_exit: bool = False,
    print_wait_ceiling_s: int = 3600,
    agent_task_timeout_s: int = 900,
) -> tuple[Print, AsyncMock]:
    soul = AsyncMock(spec=KimiSoul)
    soul.runtime = MagicMock()
    soul.runtime.role = "root"
    soul.runtime.background_tasks = manager
    soul.runtime.notifications = notifications
    soul.runtime.config.background.keep_alive_on_exit = keep_alive_on_exit
    soul.runtime.config.background.print_wait_ceiling_s = print_wait_ceiling_s
    soul.runtime.config.background.agent_task_timeout_s = agent_task_timeout_s
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
# keep_alive_on_exit: wait loop is skipped entirely
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_skips_wait_when_keep_alive_on_exit_enabled(tmp_path: Path) -> None:
    """When ``background.keep_alive_on_exit`` is True, background tasks are
    supposed to outlive the CLI exit — so Print must not block waiting for
    them to finish.  Verify the wait loop is skipped entirely (reconcile is
    not called, no re-entry happens) even when active tasks and pending LLM
    notifications are both True."""
    state = _FakeState(active=True, pending=True)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(tmp_path, manager, notifications, keep_alive_on_exit=True)
    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await p.run(command="fire and forget")

    assert code == ExitCode.SUCCESS
    # Only the original command was processed — no wait, no re-entry.
    assert len(run_soul_calls) == 1
    assert run_soul_calls[0] == "fire and forget"
    # The wait loop was never entered — reconcile must not be called.
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


# ---------------------------------------------------------------------------
# Wait timeout: kill bg tasks + one final soul turn + FAILURE exit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_print_wait_timeout_kills_and_reenters_soul(tmp_path: Path) -> None:
    """When bg tasks exceed the wait cap, Print must kill them, tell the user
    via stderr, inject a <system-reminder> describing the killed tasks, run
    one more soul turn so the LLM can summarise, and exit FAILURE."""
    views = [
        _fake_view("b-001", "deploy staging", timeout_s=30),
        _fake_view("b-002", 'agent "fix failing tests"', timeout_s=60),
    ]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=5,
        agent_task_timeout_s=900,
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        code = await p.run(command="kick off work")

    assert code == ExitCode.FAILURE
    # kill_all_active called exactly once with the timeout reason
    assert state.kill_reasons == ["print_wait_timeout"]
    # First soul run is the user command; second is the timeout follow-up
    assert len(run_soul_calls) == 2
    assert run_soul_calls[0] == "kick off work"
    prompt = run_soul_calls[1]
    assert "<system-reminder>" in prompt
    # Task list appears in the follow-up prompt
    assert "b-001" in prompt
    assert "b-002" in prompt
    assert "deploy staging" in prompt
    assert "fix failing tests" in prompt


@pytest.mark.asyncio
async def test_print_wait_timeout_followup_prompt_labels_from_post_kill_state(
    tmp_path: Path,
) -> None:
    """After ``kill_all_active`` the follow-up prompt must describe each task
    by its actual post-kill state, not by a blanket ``(killed)`` label:

    - task already terminal before we got to kill it → ``already finished``
    - kill-requested but worker still finalising        → ``kill requested``
    - kill call failed (no ``kill_requested_at``)       → ``kill failed``

    And the header must be neutral — saying "were terminated" contradicts a
    ``(kill failed)`` entry.
    """
    # Three tasks, all non-terminal at snapshot time.  One per post-kill label:
    view_done = _fake_view("b-done", "finished on its own", timeout_s=30)
    view_dying = _fake_view("b-dying", "kill in flight", timeout_s=30)
    view_leak = _fake_view("b-leak", "kill raised", timeout_s=30)
    state = _FakeState(active_views=[view_done, view_dying, view_leak], pending=False)
    manager, notifications = _wire_manager(state)

    def partial_kill(*, reason: str = "Killed") -> list[str]:
        state.kill_reasons.append(reason)
        # b-done: completed on its own during the kill loop (race).
        view_done.runtime.status = "completed"
        # b-dying: kill succeeded, SIGTERM delivered, worker still finalising.
        view_dying.control.kill_requested_at = 123.0
        # b-leak: kill raised internally → no control write, status unchanged.
        # ``kill_all_active`` appends b-done too (kill() early-returns for
        # already-terminal, outer loop still appends), but NOT b-leak.
        return ["b-done", "b-dying"]

    manager.kill_all_active.side_effect = partial_kill

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="work")

    prompt = run_soul_calls[1]
    # Header must not make the blanket "were terminated" claim
    assert "were terminated" not in prompt
    # Per-task labels must reflect each task's real post-kill state
    assert "b-done: finished on its own (already finished)" in prompt
    assert "b-dying: kill in flight (kill requested)" in prompt
    assert "b-leak: kill raised (kill failed)" in prompt


@pytest.mark.asyncio
async def test_print_wait_timeout_followup_prompt_distinguishes_kill_failures(
    tmp_path: Path,
) -> None:
    """``kill_all_active`` can fail per task (e.g. ``write_control`` raises
    on disk errors), returning only the ids that were actually kill-requested.
    The timeout follow-up prompt must reflect that distinction — a task whose
    kill failed must NOT be labelled ``(killed)`` in the prompt handed to the
    LLM, otherwise the LLM will tell the user a task was terminated when it
    wasn't.
    """
    view_ok = _fake_view("b-ok", "will be killed", timeout_s=30)
    view_fail = _fake_view("b-fail", "kill will fail", timeout_s=30)
    state = _FakeState(active_views=[view_ok, view_fail], pending=False)
    manager, notifications = _wire_manager(state)

    # Simulate b-fail's kill raising internally: the real implementation
    # catches per-task exceptions and leaves ``kill_requested_at`` unset.
    # b-ok gets the normal treatment (``kill_requested_at`` written).
    def partial_kill(*, reason: str = "Killed") -> list[str]:
        state.kill_reasons.append(reason)
        view_ok.control.kill_requested_at = 123.0
        return ["b-ok"]

    manager.kill_all_active.side_effect = partial_kill

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="work")

    assert len(run_soul_calls) == 2
    prompt = run_soul_calls[1]
    # b-ok: kill_requested_at set, status still running → "kill requested"
    assert "b-ok: will be killed (kill requested)" in prompt
    # b-fail: kill raised internally, kill_requested_at stayed None →
    # "kill failed" — must NOT be labelled as killed/terminated.
    assert "b-fail: kill will fail (kill failed)" in prompt
    assert "(killed)" not in prompt  # legacy blanket label is gone


@pytest.mark.asyncio
async def test_print_wait_timeout_reconciles_after_followup_soul(tmp_path: Path) -> None:
    """After the timeout follow-up soul turn runs, Print must reconcile() one
    more time so on-disk runtime.status (written by the worker supervisor as
    it shuts down during the soul turn) is picked up before we exit.

    Without this, the final task view can remain "running" even though the
    child was SIGTERM'd.
    """
    views = [_fake_view("b-001", "stubborn task", timeout_s=30)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    run_soul_calls: list[str] = []
    reconcile_count_at_followup: list[int] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 2:
            # Snapshot reconcile count at the start of the follow-up turn
            # so we can prove reconcile() was called AGAIN after we return.
            reconcile_count_at_followup.append(state.reconcile_count)

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        code = await p.run(command="work")

    assert code == ExitCode.FAILURE
    assert len(run_soul_calls) == 2
    assert len(reconcile_count_at_followup) == 1
    # At least one reconcile must fire AFTER the follow-up soul turn, so the
    # final on-disk status is picked up before exit.
    assert state.reconcile_count > reconcile_count_at_followup[0]


@pytest.mark.asyncio
async def test_print_wait_timeout_survives_followup_soul_exception(tmp_path: Path) -> None:
    """If the timeout follow-up soul turn raises (network error, MaxStepsReached,
    etc.), Print must still:

    - run reconcile() once more so the notification store is flushed;
    - return ExitCode.FAILURE (not get re-classified via the outer except
      handlers).

    Otherwise the user sees a provider-error exit code while stderr has already
    told them "timed out ... killed N tasks" — self-contradictory.
    """
    from kosong.chat_provider import ChatProviderError

    views = [_fake_view("b-001", "stubborn", timeout_s=30)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    run_soul_calls: list[str] = []
    reconcile_count_at_followup: list[int] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 2:
            reconcile_count_at_followup.append(state.reconcile_count)
            raise ChatProviderError("simulated provider outage during follow-up")

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        code = await p.run(command="work")

    assert code == ExitCode.FAILURE
    assert len(run_soul_calls) == 2  # original + follow-up (which raised)
    # Reconcile must still fire after the follow-up, even though it raised
    assert state.reconcile_count > reconcile_count_at_followup[0]


@pytest.mark.asyncio
async def test_print_wait_timeout_writes_to_original_stderr_when_redirected(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """When stderr is redirected to the logger, the "timed out ... killed N"
    notice must still reach the user's terminal via ``open_original_stderr``,
    not disappear into ``kimi.log``."""
    import contextlib
    import io

    views = [_fake_view("b-001", "stubborn", timeout_s=30)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    captured = io.BytesIO()

    class _FakeOriginalStream:
        def write(self, data):
            captured.write(data)

        def flush(self):
            pass

    @contextlib.contextmanager
    def fake_open_original_stderr():
        yield _FakeOriginalStream()

    monkeypatch.setattr("kimi_cli.ui.print.open_original_stderr", fake_open_original_stderr)

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        pass

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="work")

    output = captured.getvalue().decode("utf-8")
    assert "timed out" in output
    assert "killed 1 tasks" in output


@pytest.mark.asyncio
async def test_print_wait_timeout_followup_propagates_run_cancelled(tmp_path: Path) -> None:
    """If the user presses Ctrl+C during the timeout follow-up soul turn,
    ``run_soul`` raises ``RunCancelled``.  That must propagate to the outer
    ``except RunCancelled`` handler (so the user sees "Interrupted by user"
    and the cancel semantics stay intact), NOT be swallowed by the generic
    ``except Exception`` catch-all that handles transient LLM failures.
    """
    views = [_fake_view("b-001", "stubborn", timeout_s=30)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 2:
            raise RunCancelled

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
        patch("kimi_cli.ui.print.logger") as mock_logger,
    ):
        code = await p.run(command="work")

    # Both "swallowed" and "propagated" end in ExitCode.FAILURE, so we can't
    # use code alone to distinguish.  Instead, verify the outer
    # ``except RunCancelled`` branch was taken by observing its two distinct
    # side effects, neither of which fire on the "swallowed via except
    # Exception" path:
    #
    #   1. ``logger.error("Interrupted by user")`` fires
    #   2. ``logger.warning("Timeout follow-up soul turn failed...")`` does NOT fire
    assert code == ExitCode.FAILURE
    assert len(run_soul_calls) == 2

    error_calls = [str(c) for c in mock_logger.error.call_args_list]
    assert any("Interrupted by user" in c for c in error_calls)

    warning_calls = [str(c) for c in mock_logger.warning.call_args_list]
    for c in warning_calls:
        assert "Timeout follow-up soul turn failed" not in c


@pytest.mark.asyncio
async def test_print_wait_respects_zero_timeout_s(tmp_path: Path) -> None:
    """A task with explicit ``timeout_s=0`` must NOT fall back to
    ``agent_task_timeout_s`` via ``v.spec.timeout_s or default``.

    Using the falsy ``or`` idiom silently promotes 0 to 900s, contradicting
    the caller's explicit intent.  Enforce ``None``-only fallback.
    """
    views = [_fake_view("a", timeout_s=0)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=3600,
        agent_task_timeout_s=900,
    )

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        pass

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="x")

    # With timeout_s=0, wait_cap should be 0 → immediate timeout, not 900s.
    assert state.kill_reasons == ["print_wait_timeout"]
    # Should time out immediately, well under the agent default (900s).
    assert clock[0] < 5


@pytest.mark.asyncio
async def test_print_wait_cap_uses_max_of_active_timeouts(tmp_path: Path) -> None:
    """wait_cap should equal max(active.timeout_s) when below the ceiling."""
    views = [
        _fake_view("a", timeout_s=30),
        _fake_view("b", timeout_s=60),
        _fake_view("c", timeout_s=10),
    ]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=3600,
        agent_task_timeout_s=900,
    )

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        pass

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        # The production loop sleeps 1s per poll; advance fake clock in larger
        # steps to keep this test fast.
        clock[0] += max(duration, 1.0)
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="x")

    # Cap = max([30, 60, 10]) = 60, well under the 3600 ceiling.
    # Timeout should fire right around clock == 60.
    assert state.kill_reasons == ["print_wait_timeout"]
    assert 60 <= clock[0] <= 65


@pytest.mark.asyncio
async def test_print_wait_cap_respects_ceiling(tmp_path: Path) -> None:
    """When a task has a very long timeout_s, the ceiling caps the wait."""
    views = [_fake_view("x", timeout_s=10_000)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=5,
        agent_task_timeout_s=900,
    )

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        pass

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="x")

    # ceiling=5 caps the cap; should NOT wait anywhere near 10_000s.
    assert state.kill_reasons == ["print_wait_timeout"]
    assert clock[0] < 10


@pytest.mark.asyncio
async def test_print_synthetic_prompts_skip_user_prompt_hook(tmp_path: Path) -> None:
    """The ``<system-reminder>`` prompts that Print sends into ``run_soul``
    during pending re-entry and timeout follow-up are internal — not user
    input.  They must bypass ``UserPromptSubmit`` hooks so a user-configured
    prompt-blocking hook can't drop the notification and hang the wait loop.

    We verify by checking that Print passes ``skip_user_prompt_hook=True``
    via kwarg to both ``run_soul`` call sites (pending re-entry + timeout
    follow-up).  The user's original command is NOT an internal synthetic
    prompt, so its call must NOT set the flag.
    """
    views = [_fake_view("b-001", "long", timeout_s=30)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=2,
        agent_task_timeout_s=900,
    )

    reconcile_orig = manager.reconcile.side_effect

    def first_reconcile_publishes():
        reconcile_orig()
        if state.reconcile_count == 1:
            state.pending = True

    manager.reconcile.side_effect = first_reconcile_publishes

    call_flags: list[bool] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        call_flags.append(bool(kwargs.get("skip_user_prompt_hook", False)))
        # Turn 2: drain pending, keep task alive until timeout.
        if len(call_flags) == 2:
            state.pending = False

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="user request")

    # Calls: [0]=original user command, [1]=pending re-entry, [2]=timeout follow-up
    assert len(call_flags) == 3, f"expected 3 run_soul calls, got {call_flags}"
    assert call_flags[0] is False, "original user command must not skip hook"
    assert call_flags[1] is True, "pending re-entry synthetic prompt must skip hook"
    assert call_flags[2] is True, "timeout follow-up synthetic prompt must skip hook"


@pytest.mark.asyncio
async def test_print_wait_timeout_catches_tasks_spawned_during_reentry(
    tmp_path: Path,
) -> None:
    """If the initial snapshot has no active tasks but a pending re-entry
    into the soul spawns new background work, the wait loop must STILL apply
    the timeout (using the ceiling as a worst-case bound) — otherwise a
    long-running task spawned mid-wait can hang ``--print`` indefinitely,
    defeating the purpose of ``print_wait_ceiling_s``.
    """
    # Initial: no active views. Pump sets pending on the first reconcile to
    # simulate a bg task that completed between run_soul returning and our
    # first list_tasks snapshot.
    state = _FakeState(active_views=[], pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=5,
        agent_task_timeout_s=900,
    )

    reconcile_orig = manager.reconcile.side_effect

    def first_reconcile_publishes():
        reconcile_orig()
        if state.reconcile_count == 1:
            state.pending = True

    manager.reconcile.side_effect = first_reconcile_publishes

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 2:
            # Pending re-entry: drain the notification and simulate the LLM
            # spawning a new long-running task before returning.
            state.pending = False
            state.active_views = [
                _fake_view("b-new", "never ends", timeout_s=10_000),
            ]

    clock = [0.0]
    real_sleep = asyncio.sleep

    def fake_monotonic():
        return clock[0]

    async def fake_sleep(duration):
        clock[0] += duration
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        await p.run(command="work")

    # Must time out via the ceiling (~5s), not the new task's 10000s timeout.
    assert state.kill_reasons == ["print_wait_timeout"]
    assert clock[0] < 15


@pytest.mark.asyncio
async def test_pending_notification_preempts_timeout(tmp_path: Path) -> None:
    """If a completion notification is pending at the same time the deadline
    has passed, the pending path must win (option x): re-enter the soul, do
    not trigger the timeout-kill path."""
    views = [_fake_view("a", timeout_s=5)]
    state = _FakeState(active_views=views, pending=False)
    manager, notifications = _wire_manager(state)

    p, _ = _make_print_with_runtime(
        tmp_path,
        manager,
        notifications,
        print_wait_ceiling_s=3600,
        agent_task_timeout_s=900,
    )

    # On the first reconcile: publish a pending notification AND warp the
    # clock past the deadline. The loop must still take the pending branch
    # before checking the deadline.
    clock = [0.0]  # initial monotonic → deadline = 0 + 5 = 5
    reconcile_orig = manager.reconcile.side_effect

    def reconcile_warp_clock():
        reconcile_orig()
        if state.reconcile_count == 1:
            state.pending = True
            clock[0] = 100.0  # 100 >> deadline(5)

    manager.reconcile.side_effect = reconcile_warp_clock

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 2:
            # Re-entry drains pending and completes the task naturally.
            state.pending = False
            state.active_views.clear()
            state.active = False

    def fake_monotonic():
        return clock[0]

    real_sleep = asyncio.sleep

    async def fake_sleep(duration):
        await real_sleep(0)

    with (
        patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul),
        patch("kimi_cli.ui.print.asyncio.sleep", side_effect=fake_sleep),
        patch("kimi_cli.ui.print.time.monotonic", side_effect=fake_monotonic),
    ):
        code = await p.run(command="x")

    # Pending wins over the (already-breached) deadline.
    assert code == ExitCode.SUCCESS
    assert state.kill_reasons == []
    # 1 original + 1 pending re-entry, no timeout re-entry
    assert len(run_soul_calls) == 2
