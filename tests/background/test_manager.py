from __future__ import annotations

import time

import pytest

from kimi_cli.background import TaskRuntime, TaskSpec
from kimi_cli.notifications import NotificationDelivery, NotificationEvent, NotificationView


def test_create_bash_task_persists_starting_state(runtime, monkeypatch):
    manager = runtime.background_tasks

    monkeypatch.setattr(manager, "_launch_worker", lambda task_dir: 4242)

    view = manager.create_bash_task(
        command="sleep 1",
        description="short sleep",
        timeout_s=10,
        tool_call_id="tool-1",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
    )

    assert view.spec.id.startswith("b")
    assert view.runtime.status == "starting"
    assert view.runtime.worker_pid == 4242


def test_create_bash_task_respects_max_running_tasks(runtime, monkeypatch):
    runtime.config.background.max_running_tasks = 1
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b1111999",
        kind="bash",
        session_id=runtime.session.id,
        description="already running",
        tool_call_id="tool-limit",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.write_runtime(spec.id, TaskRuntime(status="running", updated_at=time.time()))

    monkeypatch.setattr(manager, "_launch_worker", lambda task_dir: 4242)

    with pytest.raises(RuntimeError, match="Too many background tasks"):
        manager.create_bash_task(
            command="sleep 1",
            description="short sleep",
            timeout_s=10,
            tool_call_id="tool-1b",
            shell_name="bash",
            shell_path="/bin/bash",
            cwd=str(runtime.session.work_dir),
        )


def test_create_bash_task_does_not_overwrite_worker_terminal_state(runtime, monkeypatch):
    manager = runtime.background_tasks
    store = manager.store

    def _launch_and_finish(task_dir):
        task_id = task_dir.name
        store.write_runtime(
            task_id,
            TaskRuntime(
                status="completed",
                worker_pid=4242,
                exit_code=0,
                finished_at=time.time(),
                updated_at=time.time(),
            ),
        )
        return 4242

    monkeypatch.setattr(manager, "_launch_worker", _launch_and_finish)

    view = manager.create_bash_task(
        command="echo done",
        description="instant completion",
        timeout_s=10,
        tool_call_id="tool-race",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
    )

    assert view.runtime.status == "completed"
    assert view.runtime.exit_code == 0
    assert view.runtime.worker_pid == 4242


def test_create_bash_task_records_failed_runtime_when_worker_launch_fails(runtime, monkeypatch):
    manager = runtime.background_tasks

    def _boom(_task_dir):
        raise RuntimeError("launch boom")

    monkeypatch.setattr(manager, "_launch_worker", _boom)

    with pytest.raises(RuntimeError, match="launch boom"):
        manager.create_bash_task(
            command="sleep 1",
            description="broken worker",
            timeout_s=10,
            tool_call_id="tool-launch-fail",
            shell_name="bash",
            shell_path="/bin/bash",
            cwd=str(runtime.session.work_dir),
        )

    views = manager.store.list_views()
    assert len(views) == 1
    assert views[0].runtime.status == "failed"
    assert views[0].runtime.failure_reason == "Failed to launch worker: launch boom"


def test_get_task_missing_does_not_create_directory(runtime):
    manager = runtime.background_tasks

    assert manager.get_task("b-missing") is None
    assert not manager.store.task_path("b-missing").exists()


def test_recover_marks_stale_running_task_as_lost(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b1111111",
        kind="bash",
        session_id=runtime.session.id,
        description="stale task",
        tool_call_id="tool-2",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    runtime_state = TaskRuntime(
        status="running",
        worker_pid=111,
        heartbeat_at=time.time() - 60,
        updated_at=time.time() - 60,
    )
    store.write_runtime(spec.id, runtime_state)

    manager.recover()

    recovered = store.merged_view(spec.id)
    assert recovered.runtime.status == "lost"
    assert recovered.runtime.failure_reason == "Background worker heartbeat expired"


def test_recover_marks_stale_starting_task_without_heartbeat_as_lost(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b1111112",
        kind="bash",
        session_id=runtime.session.id,
        description="stale starting task",
        tool_call_id="tool-2b",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    runtime_state = TaskRuntime(
        status="starting",
        worker_pid=222,
        started_at=time.time() - 60,
        updated_at=time.time() - 60,
    )
    store.write_runtime(spec.id, runtime_state)

    manager.recover()

    recovered = store.merged_view(spec.id)
    assert recovered.runtime.status == "lost"
    assert recovered.runtime.failure_reason == "Background worker never heartbeat after startup"


def test_recover_marks_stale_kill_requested_task_as_killed(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b1111113",
        kind="bash",
        session_id=runtime.session.id,
        description="stale kill task",
        tool_call_id="tool-2c",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="running",
            worker_pid=333,
            heartbeat_at=time.time() - 60,
            updated_at=time.time() - 60,
        ),
    )
    control = store.read_control(spec.id).model_copy(
        update={"kill_requested_at": time.time() - 30, "kill_reason": "user stop"}
    )
    store.write_control(spec.id, control)

    manager.recover()

    recovered = store.merged_view(spec.id)
    assert recovered.runtime.status == "killed"
    assert recovered.runtime.interrupted is True
    assert recovered.runtime.failure_reason == "user stop"


def test_publish_terminal_notifications_creates_notification(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b2222222",
        kind="bash",
        session_id=runtime.session.id,
        description="completed task",
        tool_call_id="tool-3",
        command="echo done",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="completed", exit_code=0, finished_at=time.time(), updated_at=time.time()
        ),
    )

    published = manager.publish_terminal_notifications(limit=4)
    assert len(published) == 1
    notification = runtime.notifications.store.merged_view(published[0])
    assert notification.event.source_id == spec.id
    assert notification.event.type == "task.completed"
    assert notification.event.payload["task_id"] == spec.id


def test_publish_terminal_notifications_marks_timeout_distinctly(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b2222223",
        kind="bash",
        session_id=runtime.session.id,
        description="timed out task",
        tool_call_id="tool-3b",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=1,
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="failed",
            interrupted=True,
            timed_out=True,
            finished_at=time.time(),
            updated_at=time.time(),
            failure_reason="Command timed out after 1s",
        ),
    )

    published = manager.publish_terminal_notifications(limit=4)
    assert len(published) == 1
    notification = runtime.notifications.store.merged_view(published[0])
    assert notification.event.source_id == spec.id
    assert notification.event.type == "task.timed_out"
    assert notification.event.title == "Background task timed out: timed out task"
    assert notification.event.payload["timed_out"] is True
    assert notification.event.payload["terminal_reason"] == "timed_out"


def test_reconcile_recovers_and_publishes_lost_notification(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b2222224",
        kind="bash",
        session_id=runtime.session.id,
        description="recovered lost task",
        tool_call_id="tool-3c",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="running",
            worker_pid=333,
            heartbeat_at=time.time() - 60,
            updated_at=time.time() - 60,
        ),
    )

    published = manager.reconcile(limit=4)

    assert len(published) == 1
    notification = runtime.notifications.store.merged_view(published[0])
    assert notification.event.type == "task.lost"
    assert notification.event.source_id == spec.id


def test_reconcile_does_not_republish_same_terminal_notification(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b2222225",
        kind="bash",
        session_id=runtime.session.id,
        description="one-shot completed task",
        tool_call_id="tool-3d",
        command="echo done",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="completed",
            exit_code=0,
            finished_at=time.time(),
            updated_at=time.time(),
        ),
    )

    first = manager.reconcile(limit=4)
    second = manager.reconcile(limit=4)

    assert len(first) == 1
    assert second == []


def test_publish_terminal_notifications_limit_skips_deduped_results(runtime, monkeypatch):
    manager = runtime.background_tasks
    store = manager.store
    now = time.time()
    task_ids: list[str] = []
    for index in range(2):
        task_id = f"b222223{index}"
        task_ids.append(task_id)
        spec = TaskSpec(
            id=task_id,
            kind="bash",
            session_id=runtime.session.id,
            description=f"completed task {index}",
            tool_call_id=f"tool-3e-{index}",
            command="echo done",
            shell_name="bash",
            shell_path="/bin/bash",
            cwd=str(runtime.session.work_dir),
            timeout_s=60,
        )
        store.create_task(spec)
        store.write_runtime(
            spec.id,
            TaskRuntime(
                status="completed",
                exit_code=0,
                finished_at=now - index,
                updated_at=now - index,
            ),
        )

    existing = NotificationView(
        event=NotificationEvent(
            id="n-existing",
            category="task",
            type="task.completed",
            source_kind="background_task",
            source_id=task_ids[0],
            title="Background task completed: completed task 0",
            body="Task ID: b2222230",
            severity="success",
            dedupe_key=f"background_task:{task_ids[0]}:completed",
        ),
        delivery=NotificationDelivery(),
    )
    created_ids: dict[str, str] = {}

    monkeypatch.setattr(manager._notifications, "find_by_dedupe_key", lambda _key: None)

    def _publish(event: NotificationEvent) -> NotificationView:
        if event.source_id == task_ids[0]:
            return existing
        created_ids[event.source_id] = event.id
        return NotificationView(event=event, delivery=NotificationDelivery())

    monkeypatch.setattr(manager._notifications, "publish", _publish)

    published = manager.publish_terminal_notifications(limit=1)

    assert published == [created_ids[task_ids[1]]]


@pytest.mark.asyncio
async def test_manager_launches_real_worker_and_waits(runtime):
    manager = runtime.background_tasks

    view = manager.create_bash_task(
        command="python3 -c \"print('bg-ok')\"",
        description="real worker smoke",
        timeout_s=30,
        tool_call_id="tool-7",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
    )
    waited = await manager.wait(view.spec.id, timeout_s=10)

    assert waited.runtime.status == "completed"
    assert waited.runtime.exit_code == 0
    assert "bg-ok" in manager.store.output_path(view.spec.id).read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_manager_surfaces_timeout_failure(runtime):
    manager = runtime.background_tasks

    view = manager.create_bash_task(
        command="sleep 2",
        description="real worker timeout",
        timeout_s=1,
        tool_call_id="tool-8",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
    )
    waited = await manager.wait(view.spec.id, timeout_s=10)

    assert waited.runtime.status == "failed"
    assert waited.runtime.interrupted is True
    assert waited.runtime.timed_out is True
    assert waited.runtime.failure_reason == "Command timed out after 1s"
