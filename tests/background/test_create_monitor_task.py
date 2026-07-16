import pytest

from kimi_cli.background.models import MonitorPayload, monitor_payload


@pytest.fixture
def make_manager(runtime):
    def _factory():
        return runtime.background_tasks

    return _factory


@pytest.mark.asyncio
async def test_create_monitor_task_persists_kind_and_payload(make_manager, monkeypatch):
    mgr = make_manager()
    monkeypatch.setattr(mgr, "_launch_worker", lambda task_dir: 4242)
    view = mgr.create_monitor_task(
        command="printf 'a\\nb\\n'",
        description="mon",
        timeout_s=None,
        tool_call_id="tc1",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd="/tmp",
        payload=MonitorPayload(batch_ms=50),
    )
    assert view.spec.kind == "monitor"
    assert view.spec.command == "printf 'a\\nb\\n'"
    assert view.spec.timeout_s is None
    assert monitor_payload(view.spec).batch_ms == 50
