from __future__ import annotations

import json
import time

from kimi_cli.background import BackgroundTaskStore, TaskSpec


def test_create_task_and_merge_view(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    spec = TaskSpec(
        id="b1234567",
        kind="bash",
        session_id=runtime.session.id,
        description="run tests",
        tool_call_id="call-1",
        command="pytest -q",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)

    view = store.merged_view(spec.id)
    assert view.spec.id == "b1234567"
    assert view.runtime.status == "created"
    assert view.control.kill_requested_at is None
    assert view.consumer.last_seen_output_size == 0
    assert view.consumer.last_viewed_at is None


def test_read_output_and_tail(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    spec = TaskSpec(
        id="b7654321",
        kind="bash",
        session_id=runtime.session.id,
        description="build app",
        tool_call_id="call-2",
        command="make build",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.output_path(spec.id).write_text("line1\nline2\nline3\n", encoding="utf-8")

    chunk = store.read_output(spec.id, 0, 7, status="running")
    assert chunk.text == "line1\nl"
    assert chunk.next_offset == 7
    assert chunk.eof is False

    tail = store.tail_output(spec.id, max_bytes=100, max_lines=2)
    assert tail == "line2\nline3"


def test_reading_missing_task_does_not_create_directory(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")

    runtime_state = store.read_runtime("bmissing01")
    control = store.read_control("bmissing01")
    consumer = store.read_consumer("bmissing01")

    assert runtime_state.status == "created"
    assert control.kill_requested_at is None
    assert consumer.last_seen_output_size == 0
    assert not store.task_path("bmissing01").exists()


def test_list_views_skips_invalid_task_directories(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    valid = TaskSpec(
        id="b8888888",
        kind="bash",
        session_id=runtime.session.id,
        description="valid task",
        tool_call_id="call-3",
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(valid)

    invalid_dir = store.root / "b-invalid"
    invalid_dir.mkdir(parents=True, exist_ok=True)
    (invalid_dir / "output.log").write_text("orphaned\n", encoding="utf-8")

    assert store.list_task_ids() == ["b8888888"]
    views = store.list_views()
    assert len(views) == 1
    assert views[0].spec.id == "b8888888"


def test_list_views_skips_invalid_task_id_directories_with_spec_file(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    valid = TaskSpec(
        id="b8888887",
        kind="bash",
        session_id=runtime.session.id,
        description="valid task",
        tool_call_id="call-3b",
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(valid)

    invalid_dir = store.root / "bad-task!"
    invalid_dir.mkdir(parents=True, exist_ok=True)
    (invalid_dir / store.SPEC_FILE).write_text("{}", encoding="utf-8")

    views = store.list_views()

    assert [view.spec.id for view in views] == ["b8888887"]


def test_read_runtime_invalid_json_returns_default(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    spec = TaskSpec(
        id="b9999998",
        kind="bash",
        session_id=runtime.session.id,
        description="runtime fallback",
        tool_call_id="call-4",
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.runtime_path(spec.id).write_text('{"status":"running"', encoding="utf-8")

    runtime_state = store.read_runtime(spec.id)

    assert runtime_state.status == "created"
    assert runtime_state.worker_pid is None
    assert runtime_state.updated_at == 0


def test_list_views_skips_task_with_corrupted_spec(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    valid = TaskSpec(
        id="b9999996",
        kind="bash",
        session_id=runtime.session.id,
        description="valid task",
        tool_call_id="call-5",
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(valid)

    bad_dir = store.task_dir("b9999997")
    (bad_dir / store.SPEC_FILE).write_text(json.dumps({"oops": 1}), encoding="utf-8")

    views = store.list_views()

    assert [view.spec.id for view in views] == ["b9999996"]


def test_list_views_uses_spec_created_at_when_runtime_is_corrupted(runtime):
    store = BackgroundTaskStore(runtime.session.context_file.parent / "tasks")
    older = time.time() - 60
    newer = time.time() - 10
    older_spec = TaskSpec(
        id="b9999994",
        kind="bash",
        session_id=runtime.session.id,
        description="older task",
        tool_call_id="call-6",
        created_at=older,
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    newer_spec = TaskSpec(
        id="b9999995",
        kind="bash",
        session_id=runtime.session.id,
        description="newer task",
        tool_call_id="call-7",
        created_at=newer,
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(older_spec)
    store.create_task(newer_spec)
    store.runtime_path(older_spec.id).write_text('{"status":"running"', encoding="utf-8")
    store.runtime_path(newer_spec.id).write_text('{"status":"running"', encoding="utf-8")

    views = store.list_views()

    assert [view.spec.id for view in views] == ["b9999995", "b9999994"]
