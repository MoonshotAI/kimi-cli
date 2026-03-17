from __future__ import annotations

import time

import pytest

from kimi_cli.background import TaskRuntime, TaskSpec, TaskStatus
from kimi_cli.tools.shell import Params


def _write_task(runtime, task_id: str, *, status: TaskStatus, output: str = ""):
    store = runtime.background_tasks.store
    spec = TaskSpec(
        id=task_id,
        kind="bash",
        session_id=runtime.session.id,
        description="background build",
        tool_call_id="tool-6",
        command="make build",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.output_path(task_id).write_text(output, encoding="utf-8")
    runtime_state = TaskRuntime(status=status, updated_at=time.time())
    if status in {"completed", "failed", "killed", "lost"}:
        runtime_state.finished_at = time.time()
        runtime_state.exit_code = 0 if status == "completed" else 1
    store.write_runtime(task_id, runtime_state)
    return spec


@pytest.mark.asyncio
async def test_shell_background_starts_task(shell_tool, runtime, monkeypatch):
    monkeypatch.setattr(runtime.background_tasks, "_launch_worker", lambda task_dir: 9898)

    result = await shell_tool(
        Params(
            command="sleep 1",
            timeout=10,
            run_in_background=True,
            description="sleep task",
        )
    )

    assert not result.is_error
    assert "task_id:" in result.output
    assert "status: starting" in result.output
    assert "automatic_notification: true" in result.output
    assert "human_shell_hint:" in result.output
    assert "/task list" in result.output


@pytest.mark.asyncio
async def test_shell_background_requires_description(shell_tool):
    with pytest.raises(ValueError, match="description"):
        Params(command="sleep 1", timeout=10, run_in_background=True)


@pytest.mark.asyncio
async def test_task_output_returns_completed_output(
    runtime,
    task_output_tool,
):
    spec = _write_task(
        runtime,
        "b5555555",
        status="completed",
        output="build line 1\nbuild line 2\n",
    )

    result = await task_output_tool(task_output_tool.params(task_id=spec.id, block=True, timeout=1))

    output_path = runtime.background_tasks.store.output_path(spec.id).resolve()
    assert not result.is_error
    assert "retrieval_status: success" in result.output
    assert "status: completed" in result.output
    assert f"output_path: {output_path}" in result.output
    assert "output_truncated: false" in result.output
    assert "full_output_tool: ReadFile" in result.output
    assert "full_output_hint:" in result.output
    assert "[output]" in result.output
    assert "build line 1" in result.output
    consumer = runtime.background_tasks.store.read_consumer(spec.id)
    assert consumer.last_seen_output_size == len(b"build line 1\nbuild line 2\n")
    assert consumer.last_viewed_at is not None


@pytest.mark.asyncio
async def test_task_list_returns_active_tasks(runtime, task_list_tool):
    active_spec = _write_task(
        runtime,
        "b4444444",
        status="running",
        output="still going\n",
    )
    _write_task(
        runtime,
        "b4444445",
        status="completed",
        output="done\n",
    )

    result = await task_list_tool(task_list_tool.params(active_only=True, limit=20))

    assert not result.is_error
    assert "active_background_tasks: 1" in result.output
    assert active_spec.id in result.output
    assert "b4444445" not in result.output


@pytest.mark.asyncio
async def test_task_output_returns_not_ready_for_running_task(runtime, task_output_tool):
    spec = _write_task(
        runtime,
        "b6666666",
        status="running",
        output="still working\n",
    )

    result = await task_output_tool(
        task_output_tool.params(task_id=spec.id, block=False, timeout=0)
    )

    assert not result.is_error
    assert "retrieval_status: not_ready" in result.output
    assert "status: running" in result.output
    assert "output_truncated: false" in result.output
    assert "still working" in result.output


@pytest.mark.asyncio
async def test_task_output_blocking_timeout_surfaces_timeout_retrieval_status(
    runtime, task_output_tool
):
    spec = _write_task(
        runtime,
        "b6666665",
        status="running",
        output="still working\n",
    )

    result = await task_output_tool(task_output_tool.params(task_id=spec.id, block=True, timeout=0))

    assert not result.is_error
    assert "retrieval_status: timeout" in result.output
    assert "status: running" in result.output


@pytest.mark.asyncio
async def test_task_output_missing_task_does_not_pollute_store(runtime, task_output_tool):
    result = await task_output_tool(
        task_output_tool.params(task_id="bmissing01", block=False, timeout=0)
    )

    assert result.is_error
    assert result.brief == "Task not found"
    assert runtime.background_tasks.store.list_task_ids() == []
    assert not runtime.background_tasks.store.task_path("bmissing01").exists()


@pytest.mark.asyncio
async def test_task_output_explicitly_surfaces_timeout_contract(runtime, task_output_tool):
    store = runtime.background_tasks.store
    spec = TaskSpec(
        id="b6666667",
        kind="bash",
        session_id=runtime.session.id,
        description="timeout build",
        tool_call_id="tool-6-timeout",
        command="make build",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=1,
    )
    store.create_task(spec)
    store.output_path(spec.id).write_text("partial output\n", encoding="utf-8")
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="failed",
            interrupted=True,
            timed_out=True,
            updated_at=time.time(),
            finished_at=time.time(),
            failure_reason="Command timed out after 1s",
        ),
    )

    result = await task_output_tool(task_output_tool.params(task_id=spec.id, block=True, timeout=1))

    output_path = runtime.background_tasks.store.output_path(spec.id).resolve()
    assert not result.is_error
    assert "status: failed" in result.output
    assert "interrupted: true" in result.output
    assert "timed_out: true" in result.output
    assert "terminal_reason: timed_out" in result.output
    assert "reason: Command timed out after 1s" in result.output
    assert f"output_path: {output_path}" in result.output


@pytest.mark.asyncio
async def test_task_output_surfaces_truncated_preview_and_full_log_path(runtime, task_output_tool):
    output = "first marker\n" + ("x" * (33 << 10)) + "\nlast marker\n"
    spec = _write_task(
        runtime,
        "b9999999",
        status="completed",
        output=output,
    )

    result = await task_output_tool(task_output_tool.params(task_id=spec.id, block=True, timeout=1))

    assert not result.is_error
    output_path = runtime.background_tasks.store.output_path(spec.id).resolve()
    assert f"output_path: {output_path}" in result.output
    assert "output_preview_bytes: 32768" in result.output
    assert f"output_size_bytes: {len(output.encode('utf-8'))}" in result.output
    assert "output_truncated: true" in result.output
    assert f"[Truncated. Full output: {output_path}]" in result.output
    assert "last marker" in result.output
    assert "first marker" not in result.output
    assert (
        f'Use ReadFile(path="{output_path}", line_offset=1, n_lines=300) to inspect the full log.'
        in result.output
    )


@pytest.mark.asyncio
async def test_task_list_can_include_terminal_tasks(runtime, task_list_tool):
    _write_task(
        runtime,
        "b4444444",
        status="running",
        output="still going\n",
    )
    completed = _write_task(
        runtime,
        "b4444445",
        status="completed",
        output="done\n",
    )

    result = await task_list_tool(task_list_tool.params(active_only=False, limit=1))

    assert not result.is_error
    assert "background_tasks: 1" in result.output
    assert completed.id in result.output


@pytest.mark.asyncio
async def test_background_tools_reject_non_root_runtime(
    runtime, task_list_tool, task_output_tool, task_stop_tool
):
    runtime.role = "fixed_subagent"

    list_result = await task_list_tool(task_list_tool.params(active_only=True, limit=20))
    output_result = await task_output_tool(
        task_output_tool.params(task_id="bmissing01", block=False, timeout=0)
    )
    stop_result = await task_stop_tool(task_stop_tool.params(task_id="bmissing01"))

    assert list_result.is_error
    assert output_result.is_error
    assert stop_result.is_error
    assert list_result.brief == "Background task unavailable"
    assert output_result.brief == "Background task unavailable"
    assert stop_result.brief == "Background task unavailable"


@pytest.mark.asyncio
async def test_task_stop_blocks_in_plan_mode(runtime, task_stop_tool):
    runtime.session.state.plan_mode = True
    result = await task_stop_tool(task_stop_tool.params(task_id="b-noop"))
    assert result.is_error
    assert result.brief == "Blocked in plan mode"


@pytest.mark.asyncio
async def test_task_stop_rejected_by_approval(runtime, task_stop_tool, monkeypatch):
    spec = _write_task(
        runtime,
        "b7777776",
        status="running",
        output="watching\n",
    )

    async def _reject(*_args, **_kwargs):
        return False

    monkeypatch.setattr(task_stop_tool._approval, "request", _reject)

    result = await task_stop_tool(
        task_stop_tool.params(task_id=spec.id, reason="Stop watcher process")
    )

    assert result.is_error
    assert result.brief == "Rejected by user"
    control = runtime.background_tasks.store.read_control(spec.id)
    assert control.kill_requested_at is None


@pytest.mark.asyncio
async def test_task_stop_requests_stop_for_running_task(runtime, task_stop_tool):
    spec = _write_task(
        runtime,
        "b7777777",
        status="running",
        output="watching\n",
    )

    result = await task_stop_tool(
        task_stop_tool.params(task_id=spec.id, reason="Stop watcher process")
    )

    assert not result.is_error
    assert result.message == "Task stop requested."
    control = runtime.background_tasks.store.read_control(spec.id)
    assert control.kill_requested_at is not None
    assert control.kill_reason == "Stop watcher process"


@pytest.mark.asyncio
async def test_task_stop_on_terminal_task_is_noop(runtime, task_stop_tool):
    spec = _write_task(
        runtime,
        "b7777778",
        status="completed",
        output="done\n",
    )

    result = await task_stop_tool(task_stop_tool.params(task_id=spec.id, reason="Stop anyway"))

    assert not result.is_error
    assert "status: completed" in result.output
    control = runtime.background_tasks.store.read_control(spec.id)
    assert control.kill_requested_at is None
