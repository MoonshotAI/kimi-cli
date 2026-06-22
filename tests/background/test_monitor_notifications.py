import pytest

from kimi_cli.background.models import MonitorPayload


@pytest.mark.asyncio
async def test_volume_cap_auto_kills_and_warns(make_manager, write_output, monkeypatch):
    mgr = make_manager()
    monkeypatch.setattr(mgr, "_launch_worker", lambda task_dir: 4242)
    view = mgr.create_monitor_task(
        command="true",
        description="flood",
        timeout_s=None,
        tool_call_id="t",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd="/tmp",
        payload=MonitorPayload(max_lines_per_window=3, volume_window_s=999),
    )
    tid = view.spec.id
    write_output(tid, "".join(f"l{i}\n" for i in range(10)))
    ids = mgr.publish_monitor_notifications()
    sevs = [mgr._notifications.store.read_event(i).severity for i in ids]
    assert "warning" in sevs  # auto-stop warning emitted


@pytest.fixture
def make_manager(runtime):
    def _factory():
        return runtime.background_tasks

    return _factory


@pytest.fixture
def write_output(make_manager):
    def _write(task_id: str, text: str) -> None:
        mgr = make_manager()
        path = mgr.resolve_output_path(task_id)
        path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8")

    return _write


@pytest.mark.asyncio
async def test_emits_one_batched_notification_per_pass(make_manager, write_output, monkeypatch):
    mgr = make_manager()
    monkeypatch.setattr(mgr, "_launch_worker", lambda task_dir: 4242)
    view = mgr.create_monitor_task(
        command="true",
        description="mon",
        timeout_s=None,
        tool_call_id="t",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd="/tmp",
        payload=MonitorPayload(),
    )
    tid = view.spec.id
    write_output(tid, "line one\nline two\n")  # full lines
    ids = mgr.publish_monitor_notifications()
    assert len(ids) == 1
    ev = mgr._notifications.store.read_event(ids[0])  # file-based store
    assert ev.type == "monitor_line" and ev.source_id == tid
    assert ev.body == "line one\nline two" and ev.title == "mon"
    # offset advanced; no replay on a second pass with no new bytes
    assert mgr.publish_monitor_notifications() == []


@pytest.mark.asyncio
async def test_partial_trailing_line_not_emitted_until_complete(
    make_manager, write_output, monkeypatch
):
    mgr = make_manager()
    monkeypatch.setattr(mgr, "_launch_worker", lambda task_dir: 4242)
    view = mgr.create_monitor_task(
        command="true",
        description="m",
        timeout_s=None,
        tool_call_id="t",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd="/tmp",
        payload=MonitorPayload(),
    )
    tid = view.spec.id
    write_output(tid, "partial")  # no newline yet
    assert mgr.publish_monitor_notifications() == []  # nothing emitted
    write_output(tid, " done\n")  # completes the line
    ids = mgr.publish_monitor_notifications()
    ev = mgr._notifications.store.read_event(ids[0])
    assert ev.body == "partial done"
