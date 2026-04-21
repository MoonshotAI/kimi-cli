"""Integration test: Print mode background wait with real task/notification stores.

Unlike the unit tests in test_kimisoul_background_wait.py (which mock
has_active_tasks/reconcile/has_pending_for_sink independently), this test
exercises the **real** reconcile → publish_terminal_notifications →
has_pending_for_sink chain with file-backed stores.  It verifies that the
Print wait loop correctly detects background task completions and re-enters
the soul to process completion notifications.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kimi_cli.background.manager import BackgroundTaskManager
from kimi_cli.background.models import TaskRuntime, TaskSpec
from kimi_cli.cli import ExitCode
from kimi_cli.config import BackgroundConfig, NotificationConfig
from kimi_cli.notifications.manager import NotificationManager
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.print import Print
from kimi_cli.wire.file import WireFile


def _make_session(tmp_path: Path) -> MagicMock:
    """Create a minimal mock Session pointing at tmp_path for file stores."""
    session = MagicMock()
    session.id = "integration-test"
    session.context_file = tmp_path / "context.jsonl"
    session.wire_file = WireFile(path=tmp_path / "wire.jsonl")
    # Ensure parent dirs exist
    session.context_file.parent.mkdir(parents=True, exist_ok=True)
    return session


def _create_running_task(manager: BackgroundTaskManager, task_id: str) -> None:
    """Create a bash-kind task in the store and mark it as running.

    We deliberately use ``kind="bash"`` (not ``"agent"``) because
    ``recover()`` marks any running ``agent`` task that is not in
    ``_live_agent_tasks`` as ``lost`` immediately.  ``bash`` tasks are
    kept alive while their ``heartbeat_at`` is fresh — perfect for
    simulating an in-progress worker without actually spawning one.
    """
    now = time.time()
    spec = TaskSpec(
        id=task_id,
        kind="bash",
        session_id="integration-test",
        description=f"Test task {task_id}",
        tool_call_id=f"call-{task_id}",
        owner_role="root",
        command="true",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd="/tmp",
        timeout_s=60,
    )
    manager.store.create_task(spec)
    runtime = TaskRuntime(
        status="running",
        started_at=now,
        heartbeat_at=now,  # fresh heartbeat → recover() will not mark as lost
        updated_at=now,
    )
    manager.store.write_runtime(task_id, runtime)


def _complete_task(manager: BackgroundTaskManager, task_id: str) -> None:
    """Mark a task as completed by writing terminal runtime status to disk."""
    now = time.time()
    runtime = TaskRuntime(
        status="completed",
        exit_code=0,
        finished_at=now,
        updated_at=now,
    )
    manager.store.write_runtime(task_id, runtime)


@pytest.mark.asyncio
async def test_real_reconcile_publishes_notification_and_triggers_reentry(
    tmp_path: Path,
) -> None:
    """End-to-end integration: a running task completes on disk, reconcile()
    publishes a terminal notification, has_pending_for_sink("llm") returns
    True, and Print re-enters run_soul."""
    session = _make_session(tmp_path)
    bg_config = BackgroundConfig()
    notif_config = NotificationConfig()

    notifications = NotificationManager(tmp_path / "notifications", notif_config)
    manager = BackgroundTaskManager(session, bg_config, notifications=notifications)

    # Create a task that is "running"
    _create_running_task(manager, "b-int-00001")

    # Verify preconditions
    assert manager.has_active_tasks()
    assert not notifications.has_pending_for_sink("llm")

    # Build a mock soul whose .runtime exposes the real manager/notifications
    soul = AsyncMock(spec=KimiSoul)
    soul.runtime = MagicMock()
    soul.runtime.role = "root"
    soul.runtime.config.background.keep_alive_on_exit = False
    soul.runtime.config.background.print_wait_ceiling_s = 3600
    soul.runtime.config.background.agent_task_timeout_s = 900
    soul.runtime.background_tasks = manager
    soul.runtime.notifications = notifications
    soul.runtime.session = session

    p = Print(
        soul=soul,
        input_format="text",
        output_format="text",
        context_file=tmp_path / "ctx.json",
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 1:
            # After the first run_soul, simulate the background worker
            # completing by writing terminal status to disk.  The wait loop's
            # reconcile() will pick this up.
            _complete_task(manager, "b-int-00001")
        else:
            # On re-entry, simulate the real soul draining pending
            # "llm" notifications (like deliver_pending would).
            for view in notifications.claim_for_sink("llm"):
                notifications.ack("llm", view.event.id)

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await asyncio.wait_for(p.run(command="do work"), timeout=10.0)

    assert code == ExitCode.SUCCESS

    # The real chain was exercised:
    #   1. run_soul returns, _complete_task wrote terminal status
    #   2. pre-loop reconcile() → publish_terminal_notifications() publishes
    #      a "task.completed" notification targeting the "llm" sink
    #   3. while: has_active_tasks()=False, has_pending_for_sink("llm")=True
    #      → enter body
    #   4. body: has_active_tasks()=False → re-enter run_soul
    #   5. re-entry mock acks the notification
    #   6. while: both conditions False → exit
    assert len(run_soul_calls) == 2
    assert run_soul_calls[0] == "do work"
    assert "<system-reminder>" in run_soul_calls[1]
    assert not notifications.has_pending_for_sink("llm")


@pytest.mark.asyncio
async def test_real_reconcile_no_reentry_when_task_completes_without_notification(
    tmp_path: Path,
) -> None:
    """If a task completes and reconcile() publishes a notification, but then
    the notification is acked (drained) by run_soul, no further re-entry
    should happen."""
    session = _make_session(tmp_path)
    notifications = NotificationManager(tmp_path / "notifications", NotificationConfig())
    manager = BackgroundTaskManager(session, BackgroundConfig(), notifications=notifications)

    _create_running_task(manager, "b-int-00002")

    soul = AsyncMock(spec=KimiSoul)
    soul.runtime = MagicMock()
    soul.runtime.role = "root"
    soul.runtime.config.background.keep_alive_on_exit = False
    soul.runtime.config.background.print_wait_ceiling_s = 3600
    soul.runtime.config.background.agent_task_timeout_s = 900
    soul.runtime.background_tasks = manager
    soul.runtime.notifications = notifications
    soul.runtime.session = session

    p = Print(
        soul=soul,
        input_format="text",
        output_format="text",
        context_file=tmp_path / "ctx.json",
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) == 1:
            _complete_task(manager, "b-int-00002")
        elif len(run_soul_calls) == 2:
            # Simulate the soul draining all pending "llm" notifications
            # during this re-entry (like real deliver_pending would).
            for view in notifications.claim_for_sink("llm"):
                notifications.ack("llm", view.event.id)

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await asyncio.wait_for(p.run(command="drain test"), timeout=10.0)

    assert code == ExitCode.SUCCESS
    # First call: original command; second: bg-task follow-up.
    # No third call because the re-entry acked all notifications.
    assert len(run_soul_calls) == 2
    assert not notifications.has_pending_for_sink("llm")


@pytest.mark.asyncio
async def test_real_reconcile_multiple_tasks(
    tmp_path: Path,
) -> None:
    """With two tasks, the first completing triggers reconcile + notification;
    the second still keeps the loop active until it also completes."""
    session = _make_session(tmp_path)
    notifications = NotificationManager(tmp_path / "notifications", NotificationConfig())
    manager = BackgroundTaskManager(session, BackgroundConfig(), notifications=notifications)

    _create_running_task(manager, "b-int-00003")
    _create_running_task(manager, "b-int-00004")

    soul = AsyncMock(spec=KimiSoul)
    soul.runtime = MagicMock()
    soul.runtime.role = "root"
    soul.runtime.config.background.keep_alive_on_exit = False
    soul.runtime.config.background.print_wait_ceiling_s = 3600
    soul.runtime.config.background.agent_task_timeout_s = 900
    soul.runtime.background_tasks = manager
    soul.runtime.notifications = notifications
    soul.runtime.session = session

    p = Print(
        soul=soul,
        input_format="text",
        output_format="text",
        context_file=tmp_path / "ctx.json",
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        # Ack any pending LLM notifications, like real deliver_pending would
        for view in notifications.claim_for_sink("llm"):
            notifications.ack("llm", view.event.id)
        if len(run_soul_calls) == 1:
            # First run: complete task 003, leave 004 running
            _complete_task(manager, "b-int-00003")
        elif len(run_soul_calls) == 2:
            # Re-entry after task 003's notification: complete task 004
            _complete_task(manager, "b-int-00004")

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await asyncio.wait_for(p.run(command="two tasks"), timeout=15.0)

    assert code == ExitCode.SUCCESS
    # 1 original + 1 re-entry (task 003 done) + 1 re-entry (task 004 done)
    assert len(run_soul_calls) == 3
    assert not notifications.has_pending_for_sink("llm")


@pytest.mark.asyncio
async def test_race_window_worker_finishes_between_reconcile_and_active_check(
    tmp_path: Path,
) -> None:
    """Guard against the race where a worker writes terminal status between
    the top-of-loop reconcile() and the has_active_tasks() check.  Without
    a final double-check reconcile() before break, the completion
    notification would be lost and the process would exit without
    informing the LLM.

    We simulate the race by wrapping has_active_tasks(): on the call that
    sees no active tasks, we first flip the underlying task to completed
    on disk.  Then the "final reconcile" inside the break branch must
    still publish the notification and the loop must re-enter the soul.
    """
    session = _make_session(tmp_path)
    notifications = NotificationManager(tmp_path / "notifications", NotificationConfig())
    manager = BackgroundTaskManager(session, BackgroundConfig(), notifications=notifications)

    _create_running_task(manager, "b-int-race1")

    # Wrap has_active_tasks so that right before it reports "no active
    # tasks", we simulate the worker flipping the runtime to terminal on
    # disk.  The top-of-loop reconcile already ran before this point, so
    # the only way the notification gets published is via a SECOND
    # reconcile after the active check — that's the P1 fix under test.
    real_has_active = manager.has_active_tasks
    task_completed_on_disk = {"done": False}

    def racy_has_active():
        if not task_completed_on_disk["done"]:
            # First call in this iteration: tasks are "running"; but
            # simulate the worker completing right before the next
            # snapshot by flipping it here.  The next reconcile() must
            # still catch it.
            _complete_task(manager, "b-int-race1")
            task_completed_on_disk["done"] = True
            return False
        return real_has_active()

    manager.has_active_tasks = racy_has_active  # type: ignore[method-assign]

    soul = AsyncMock(spec=KimiSoul)
    soul.runtime = MagicMock()
    soul.runtime.role = "root"
    soul.runtime.config.background.keep_alive_on_exit = False
    soul.runtime.config.background.print_wait_ceiling_s = 3600
    soul.runtime.config.background.agent_task_timeout_s = 900
    soul.runtime.background_tasks = manager
    soul.runtime.notifications = notifications
    soul.runtime.session = session

    p = Print(
        soul=soul,
        input_format="text",
        output_format="text",
        context_file=tmp_path / "ctx.json",
    )

    run_soul_calls: list[str] = []

    async def fake_run_soul(soul_arg, user_input, *args, **kwargs):
        run_soul_calls.append(user_input)
        if len(run_soul_calls) > 1:
            for view in notifications.claim_for_sink("llm"):
                notifications.ack("llm", view.event.id)

    with patch("kimi_cli.ui.print.run_soul", side_effect=fake_run_soul):
        code = await asyncio.wait_for(p.run(command="race"), timeout=10.0)

    assert code == ExitCode.SUCCESS
    # Without the double-check reconcile, this would be 1 (the race loses
    # the completion notification).  With the fix, it is 2.
    assert len(run_soul_calls) == 2
    assert "<system-reminder>" in run_soul_calls[1]
