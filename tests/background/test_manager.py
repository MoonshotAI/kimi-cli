from __future__ import annotations

import asyncio
import contextlib
import time

import pytest
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.approval_runtime import ApprovalRequestRecord, ApprovalRuntimeEvent, ApprovalSource
from kimi_cli.background import TaskRuntime, TaskSpec
from kimi_cli.background.agent_runner import BackgroundAgentRunner
from kimi_cli.notifications import NotificationDelivery, NotificationEvent, NotificationView
from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.soul.context import Context
from kimi_cli.subagents import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy
from kimi_cli.wire.types import TextPart


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

    assert view.spec.id.startswith("bash-")
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


@pytest.mark.asyncio
async def test_create_agent_task_persists_timeout_s_on_spec(runtime, monkeypatch):
    """``TaskSpec.timeout_s`` must carry the effective agent timeout so that
    downstream consumers (Print mode's ``print_wait_ceiling_s`` calculation)
    can respect an explicit per-agent timeout instead of always falling back
    to ``agent_task_timeout_s``.
    """
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    manager = runtime.background_tasks

    async def _noop(self):
        return None

    monkeypatch.setattr("kimi_cli.background.agent_runner.BackgroundAgentRunner.run", _noop)

    # Explicit per-task timeout — must land on the persisted spec.
    view = manager.create_agent_task(
        agent_id="a7777777",
        subagent_type="coder",
        prompt="long task",
        description="custom timeout",
        tool_call_id="tool-agent-timeout",
        model_override=None,
        timeout_s=1800,
    )

    assert view.spec.timeout_s == 1800
    task = manager._live_agent_tasks.pop(view.spec.id)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_create_agent_task_persists_default_timeout_on_spec(runtime, monkeypatch):
    """When the caller does not supply ``timeout_s``, the effective default
    (``config.background.agent_task_timeout_s``) must still land on the spec —
    otherwise Print's wait cap reader hits ``None`` and the explicit config
    value is silently ignored on the shutdown path."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    manager = runtime.background_tasks
    expected_default = runtime.config.background.agent_task_timeout_s

    async def _noop(self):
        return None

    monkeypatch.setattr("kimi_cli.background.agent_runner.BackgroundAgentRunner.run", _noop)

    view = manager.create_agent_task(
        agent_id="a8888888",
        subagent_type="coder",
        prompt="default timeout",
        description="default",
        tool_call_id="tool-agent-default",
        model_override=None,
    )

    assert view.spec.timeout_s == expected_default
    task = manager._live_agent_tasks.pop(view.spec.id)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_create_agent_task_zero_timeout_s_stays_zero(runtime, monkeypatch):
    """``timeout_s=0`` must mean zero, not be silently promoted to
    ``config.background.agent_task_timeout_s`` via the falsy ``or`` idiom.
    Matches the analogous ``None`` check used by Print's wait-cap reader."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    manager = runtime.background_tasks

    async def _noop(self):
        return None

    monkeypatch.setattr("kimi_cli.background.agent_runner.BackgroundAgentRunner.run", _noop)

    view = manager.create_agent_task(
        agent_id="a9999999",
        subagent_type="coder",
        prompt="zero timeout",
        description="zero",
        tool_call_id="tool-agent-zero",
        model_override=None,
        timeout_s=0,
    )

    assert view.spec.timeout_s == 0
    task = manager._live_agent_tasks.pop(view.spec.id)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_create_agent_task_persists_starting_state(runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    manager = runtime.background_tasks

    async def _noop(self):
        return None

    monkeypatch.setattr("kimi_cli.background.agent_runner.BackgroundAgentRunner.run", _noop)

    view = manager.create_agent_task(
        agent_id="a1234567",
        subagent_type="coder",
        prompt="investigate",
        description="investigate bug",
        tool_call_id="tool-agent-1",
        model_override=None,
    )

    assert view.spec.id.startswith("agent-")
    assert view.spec.kind == "agent"
    assert view.runtime.status == "starting"
    assert view.spec.kind_payload["agent_id"] == "a1234567"
    assert view.spec.kind_payload["subagent_type"] == "coder"
    task = manager._live_agent_tasks.pop(view.spec.id)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_background_agent_resume_restores_system_prompt_from_context(runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    runtime.subagent_store.create_instance(
        agent_id="aexisting",
        description="existing agent",
        launch_spec=AgentLaunchSpec(
            agent_id="aexisting",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    context = Context(runtime.subagent_store.context_path("aexisting"))
    await context.write_system_prompt("old system prompt")

    seen_prompts: list[str] = []

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="new system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul,
        user_input,
        ui_loop_fn,
        cancel_event,
        wire_file=None,
        runtime=None,
    ):
        seen_prompts.append(soul.agent.system_prompt)
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="x" * 250)])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    view = runtime.background_tasks.create_agent_task(
        agent_id="aexisting",
        subagent_type="coder",
        prompt="continue the work",
        description="resume task",
        tool_call_id="tool-agent-resume",
        model_override=None,
    )
    task = runtime.background_tasks._live_agent_tasks[view.spec.id]
    await task

    assert seen_prompts == ["old system prompt"]
    record = runtime.subagent_store.require_instance("aexisting")
    assert record.status == "idle"


@pytest.mark.asyncio
async def test_background_agent_runner_records_wire_file_and_stage_markers(runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    runtime.subagent_store.create_instance(
        agent_id="awiretest",
        description="wire test agent",
        launch_spec=AgentLaunchSpec(
            agent_id="awiretest",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    seen_wire_paths: list[str] = []

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul,
        user_input,
        ui_loop_fn,
        cancel_event,
        wire_file=None,
        runtime=None,
    ):
        seen_wire_paths.append(str(wire_file.path) if wire_file is not None else "")
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="x" * 250)])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    view = runtime.background_tasks.create_agent_task(
        agent_id="awiretest",
        subagent_type="coder",
        prompt="do work",
        description="wire test agent",
        tool_call_id="tool-agent-wire",
        model_override=None,
    )
    task = runtime.background_tasks._live_agent_tasks[view.spec.id]
    await task

    assert seen_wire_paths == [str(runtime.subagent_store.wire_path("awiretest"))]
    output = runtime.background_tasks.store.output_path(view.spec.id).read_text(encoding="utf-8")
    assert "[stage] runner_started" in output
    assert "[stage] agent_built" in output
    assert "[stage] context_ready" in output
    assert "[stage] run_soul_start" in output
    assert "[stage] run_soul_finished" in output


@pytest.mark.asyncio
async def test_background_agent_runner_reports_rejected_tool_calls_clearly(runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    runtime.subagent_store.create_instance(
        agent_id="arejectedbg",
        description="rejected background agent",
        launch_spec=AgentLaunchSpec(
            agent_id="arejectedbg",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul,
        user_input,
        ui_loop_fn,
        cancel_event,
        wire_file=None,
        runtime=None,
    ):
        # Subagents continue after rejection — the LLM sees the rejection and
        # produces an assistant response instead of stopping.
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="x" * 250)])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    view = runtime.background_tasks.create_agent_task(
        agent_id="arejectedbg",
        subagent_type="coder",
        prompt="do work",
        description="rejected background agent",
        tool_call_id="tool-agent-reject",
        model_override=None,
    )
    task = runtime.background_tasks._live_agent_tasks[view.spec.id]
    await task

    runtime_after = runtime.background_tasks.store.read_runtime(view.spec.id)
    assert runtime_after.status == "completed"
    record = runtime.subagent_store.require_instance("arejectedbg")
    assert record.status == "idle"


@pytest.mark.asyncio
async def test_background_agent_approval_callback_defers_state_update(runtime, monkeypatch):
    calls: list[tuple[str, str, str | None]] = []

    def fake_mark_task_awaiting_approval(task_id: str, reason: str) -> None:
        calls.append(("awaiting", task_id, reason))

    def fake_mark_task_running(task_id: str) -> None:
        calls.append(("running", task_id, None))

    monkeypatch.setattr(
        runtime.background_tasks,
        "_mark_task_awaiting_approval",
        fake_mark_task_awaiting_approval,
    )
    monkeypatch.setattr(
        runtime.background_tasks,
        "_mark_task_running",
        fake_mark_task_running,
    )

    runner = BackgroundAgentRunner(
        runtime=runtime,
        manager=runtime.background_tasks,
        task_id="a-task-approval",
        agent_id="a1234567",
        subagent_type="coder",
        prompt="continue",
        model_override=None,
    )
    request = ApprovalRequestRecord(
        id="req-approval",
        tool_call_id="call-approval",
        sender="WriteFile",
        action="edit file",
        description="Edit target file",
        display=[],
        source=ApprovalSource(kind="background_agent", id="a-task-approval"),
    )

    runner._on_approval_runtime_event(ApprovalRuntimeEvent(kind="request_created", request=request))
    assert calls == []
    await asyncio.gather(*list(runner._approval_update_tasks))
    assert calls == [("awaiting", "a-task-approval", "Edit target file")]

    runner._on_approval_runtime_event(
        ApprovalRuntimeEvent(kind="request_resolved", request=request)
    )
    assert calls == [("awaiting", "a-task-approval", "Edit target file")]
    await asyncio.gather(*list(runner._approval_update_tasks))
    assert calls == [
        ("awaiting", "a-task-approval", "Edit target file"),
        ("running", "a-task-approval", None),
    ]


@pytest.mark.asyncio
async def test_background_agent_stays_awaiting_when_other_approvals_are_still_pending(
    runtime, monkeypatch
):
    calls: list[tuple[str, str, str | None]] = []

    def fake_mark_task_awaiting_approval(task_id: str, reason: str) -> None:
        calls.append(("awaiting", task_id, reason))

    def fake_mark_task_running(task_id: str) -> None:
        calls.append(("running", task_id, None))

    monkeypatch.setattr(
        runtime.background_tasks,
        "_mark_task_awaiting_approval",
        fake_mark_task_awaiting_approval,
    )
    monkeypatch.setattr(
        runtime.background_tasks,
        "_mark_task_running",
        fake_mark_task_running,
    )

    runner = BackgroundAgentRunner(
        runtime=runtime,
        manager=runtime.background_tasks,
        task_id="a-task-multi-approval",
        agent_id="a1234567",
        subagent_type="coder",
        prompt="continue",
        model_override=None,
    )
    resolved_request = ApprovalRequestRecord(
        id="req-approval-1",
        tool_call_id="call-approval-1",
        sender="WriteFile",
        action="edit file",
        description="Edit target file",
        display=[],
        source=ApprovalSource(kind="background_agent", id="a-task-multi-approval"),
    )
    runtime.approval_runtime.create_request(
        request_id="req-approval-2",
        tool_call_id="call-approval-2",
        sender="WriteFile",
        action="edit file",
        description="Edit target file again",
        display=[],
        source=ApprovalSource(kind="background_agent", id="a-task-multi-approval"),
    )

    runner._on_approval_runtime_event(
        ApprovalRuntimeEvent(kind="request_resolved", request=resolved_request)
    )
    await asyncio.gather(*list(runner._approval_update_tasks))

    assert calls == []


def test_get_task_missing_does_not_create_directory(runtime):
    manager = runtime.background_tasks

    assert manager.get_task("bmissing01") is None
    assert not manager.store.task_path("bmissing01").exists()


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


def test_recover_marks_stale_agent_task_lost_and_clears_instance_running_state(runtime):
    manager = runtime.background_tasks
    store = manager.store
    runtime.subagent_store.create_instance(
        agent_id="alostagent",
        description="lost background agent",
        launch_spec=AgentLaunchSpec(
            agent_id="alostagent",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    runtime.subagent_store.update_instance("alostagent", status="running_background")

    spec = TaskSpec(
        id="alosttask1",
        kind="agent",
        session_id=runtime.session.id,
        description="lost agent task",
        tool_call_id="tool-lost-agent",
        owner_role="root",
        kind_payload={
            "agent_id": "alostagent",
            "subagent_type": "coder",
            "prompt": "do work",
            "model_override": None,
            "launch_mode": "background",
        },
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="running",
            updated_at=time.time() - 60,
            heartbeat_at=time.time() - 60,
        ),
    )

    manager.recover()

    recovered = store.merged_view(spec.id)
    assert recovered.runtime.status == "lost"
    assert recovered.runtime.failure_reason == "In-process background agent is no longer running"
    instance = runtime.subagent_store.require_instance("alostagent")
    assert instance.status == "failed"


def test_mark_task_running_does_not_overwrite_terminal_state(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="aterminal1",
        kind="agent",
        session_id=runtime.session.id,
        description="terminal task",
        tool_call_id="tool-terminal-1",
        owner_role="root",
        kind_payload={
            "agent_id": "a1234567",
            "subagent_type": "coder",
            "prompt": "do work",
            "model_override": None,
            "launch_mode": "background",
        },
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="killed",
            updated_at=time.time(),
            finished_at=time.time(),
            interrupted=True,
            failure_reason="Killed by user",
        ),
    )

    manager._mark_task_running(spec.id)

    runtime_after = store.read_runtime(spec.id)
    assert runtime_after.status == "killed"
    assert runtime_after.failure_reason == "Killed by user"


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


def test_mark_task_running_and_completed_clear_approval_reason(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="a3333333",
        kind="agent",
        session_id=runtime.session.id,
        description="approval task",
        tool_call_id="tool-approval-clear",
        owner_role="root",
        kind_payload={"agent_id": "aagent", "subagent_type": "coder"},
    )
    store.create_task(spec)
    store.write_runtime(
        spec.id,
        TaskRuntime(
            status="awaiting_approval",
            updated_at=time.time(),
            failure_reason="Need approval to edit file",
        ),
    )

    manager._mark_task_running(spec.id)
    running = store.merged_view(spec.id)
    assert running.runtime.status == "running"
    assert running.runtime.failure_reason is None

    store.write_runtime(
        spec.id,
        running.runtime.model_copy(
            update={"status": "awaiting_approval", "failure_reason": "Need approval again"}
        ),
    )
    manager._mark_task_completed(spec.id)
    completed = store.merged_view(spec.id)
    assert completed.runtime.status == "completed"
    assert completed.runtime.failure_reason is None


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


def test_reconcile_marks_task_lost_when_runtime_json_is_corrupted(runtime):
    manager = runtime.background_tasks
    store = manager.store
    spec = TaskSpec(
        id="b2222226",
        kind="bash",
        session_id=runtime.session.id,
        description="corrupted runtime task",
        tool_call_id="tool-3e",
        created_at=time.time() - 60,
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec)
    store.runtime_path(spec.id).write_text('{"status":"running"', encoding="utf-8")

    published = manager.reconcile(limit=4)

    assert len(published) == 1
    recovered = store.merged_view(spec.id)
    assert recovered.runtime.status == "lost"
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


def test_completion_event_set_on_publish(runtime):
    """completion_event is set when a new terminal notification is published."""
    manager = runtime.background_tasks
    store = manager.store

    spec = TaskSpec(
        id="b3333330",
        kind="bash",
        session_id=runtime.session.id,
        description="event test task",
        tool_call_id="tool-ev1",
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

    assert not manager.completion_event.is_set()
    manager.publish_terminal_notifications()
    assert manager.completion_event.is_set()

    # Clear and re-publish — dedupe prevents a second signal
    manager.completion_event.clear()
    manager.publish_terminal_notifications()
    assert not manager.completion_event.is_set()

    # A distinct terminal task triggers the event again
    spec2 = TaskSpec(
        id="b3333331",
        kind="bash",
        session_id=runtime.session.id,
        description="event test task 2",
        tool_call_id="tool-ev2",
        command="echo ok",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    store.create_task(spec2)
    store.write_runtime(
        spec2.id,
        TaskRuntime(
            status="failed",
            failure_reason="boom",
            finished_at=time.time(),
            updated_at=time.time(),
        ),
    )
    manager.publish_terminal_notifications()
    assert manager.completion_event.is_set()


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
