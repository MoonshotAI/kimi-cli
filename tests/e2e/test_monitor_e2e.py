import pytest

from kimi_cli.background.models import MonitorPayload, is_terminal_status


@pytest.fixture
def make_manager(runtime):
    def _factory():
        return runtime.background_tasks

    return _factory


@pytest.mark.asyncio
async def test_monitor_streams_lines_as_notifications(make_manager):
    mgr = make_manager()
    view = mgr.create_monitor_task(
        command="printf 'A\nB\nC\n'",
        description="letters",
        timeout_s=10,
        tool_call_id="tc-monitor-e2e",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(mgr._session.work_dir),
        payload=MonitorPayload(),
    )
    tid = view.spec.id

    # Wait for the short-lived monitor command to finish.
    view = await mgr.wait(tid, timeout_s=10)
    assert is_terminal_status(view.runtime.status)
    assert view.runtime.exit_code == 0

    # Pump the notification publisher.
    published = mgr.reconcile()
    assert published

    events = [mgr._notifications.store.read_event(eid) for eid in published]
    monitor_events = [ev for ev in events if ev.type == "monitor_line" and ev.severity == "info"]
    assert monitor_events
    bodies = "\n".join(ev.body for ev in monitor_events)
    assert "A" in bodies
    assert "B" in bodies
    assert "C" in bodies
