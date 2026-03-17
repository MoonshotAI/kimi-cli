from __future__ import annotations

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

    runtime_state = store.read_runtime("b-missing")
    control = store.read_control("b-missing")
    consumer = store.read_consumer("b-missing")

    assert runtime_state.status == "created"
    assert control.kill_requested_at is None
    assert consumer.last_seen_output_size == 0
    assert not store.task_path("b-missing").exists()


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

    invalid_dir = store.root_path / "b-invalid"
    invalid_dir.mkdir(parents=True, exist_ok=True)
    (invalid_dir / "output.log").write_text("orphaned\n", encoding="utf-8")

    assert store.list_task_ids() == ["b8888888"]
    views = store.list_views()
    assert len(views) == 1
    assert views[0].spec.id == "b8888888"
