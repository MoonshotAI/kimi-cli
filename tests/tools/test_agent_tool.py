from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

import pytest
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.approval_runtime import get_current_approval_source_or_none
from kimi_cli.soul import MaxStepsReached
from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.subagents import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy
from kimi_cli.wire.types import ApprovalRequest, TextPart
from tests.conftest import tool_call_context


def _extract_agent_id(output: str) -> str:
    match = re.search(r"^agent_id: (\S+)$", output, re.MULTILINE)
    assert match is not None
    return match.group(1)


def _extract_task_id(output: str) -> str:
    match = re.search(r"^task_id: (\S+)$", output, re.MULTILINE)
    assert match is not None
    return match.group(1)


async def test_agent_tool_creates_instance_and_returns_agent_id(agent_tool, runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="done")])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    result = await agent_tool(
        agent_tool.params(
            description="investigate bug",
            prompt="look into parser issue",
        )
    )

    assert not result.is_error
    agent_id = _extract_agent_id(result.output)
    assert "resumed: false" in result.output
    assert "actual_subagent_type: coder" in result.output
    assert runtime.subagent_store.require_instance(agent_id).subagent_type == "coder"
    assert runtime.subagent_store.prompt_path(agent_id).read_text(encoding="utf-8") == (
        "look into parser issue"
    )


async def test_agent_tool_foreground_passes_subagent_wire_file(agent_tool, runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    seen_wire_paths: list[str] = []

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        seen_wire_paths.append(str(wire_file.path) if wire_file is not None else "")
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="done")])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    result = await agent_tool(
        agent_tool.params(
            description="foreground wire",
            prompt="look into parser issue",
        )
    )

    assert not result.is_error
    agent_id = _extract_agent_id(result.output)
    assert seen_wire_paths
    assert set(seen_wire_paths) == {str(runtime.subagent_store.wire_path(agent_id))}


async def test_agent_tool_resume_uses_actual_type(agent_tool, runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="mocker",
            description="The mock agent for testing purposes.",
            agent_file=runtime.subagent_store.root / "mocker.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="done")])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    runtime.subagent_store.create_instance(
        agent_id="aexisting",
        description="old instance",
        launch_spec=AgentLaunchSpec(
            agent_id="aexisting",
            subagent_type="mocker",
            model_override=None,
            effective_model=None,
        ),
    )

    result = await agent_tool(
        agent_tool.params(
            description="resume work",
            prompt="continue the previous work",
            subagent_type="coder",
            resume="aexisting",
        )
    )

    assert not result.is_error
    assert "resumed: true" in result.output
    assert "requested_subagent_type: coder" in result.output
    assert "actual_subagent_type: mocker" in result.output


async def test_agent_tool_rejects_resume_when_instance_is_already_running(agent_tool, runtime):
    runtime.subagent_store.create_instance(
        agent_id="arunning",
        description="running instance",
        launch_spec=AgentLaunchSpec(
            agent_id="arunning",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    runtime.subagent_store.update_instance("arunning", status="running_foreground")

    result = await agent_tool(
        agent_tool.params(
            description="resume work",
            prompt="continue the previous work",
            resume="arunning",
        )
    )

    assert result.is_error
    assert result.brief == "Agent failed"
    assert "cannot be resumed concurrently" in result.message


async def test_agent_tool_marks_instance_failed_when_summary_continuation_hits_max_steps(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    call_count = 0

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            await soul.context.append_message(
                Message(role="assistant", content=[TextPart(text="too short")])
            )
            return
        raise MaxStepsReached(10)

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    result = await agent_tool(
        agent_tool.params(
            description="investigate bug",
            prompt="look into parser issue",
        )
    )

    assert result.is_error
    assert result.brief == "Max steps reached"
    records = [
        record
        for record in runtime.subagent_store.list_instances()
        if record.description == "investigate bug"
    ]
    assert len(records) == 1
    assert records[0].status == "failed"


async def test_agent_tool_marks_instance_killed_when_summary_continuation_is_cancelled(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    call_count = 0

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            await soul.context.append_message(
                Message(role="assistant", content=[TextPart(text="too short")])
            )
            return
        raise asyncio.CancelledError()

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    with pytest.raises(asyncio.CancelledError):
        await agent_tool(
            agent_tool.params(
                description="cancelled summary continuation",
                prompt="look into parser issue",
            )
        )

    records = [
        record
        for record in runtime.subagent_store.list_instances()
        if record.description == "cancelled summary continuation"
    ]
    assert len(records) == 1
    assert records[0].status == "killed"


async def test_agent_tool_marks_instance_failed_when_initial_run_raises(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        raise RuntimeError("boom")

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    result = await agent_tool(
        agent_tool.params(
            description="initial failure",
            prompt="look into parser issue",
        )
    )

    assert result.is_error
    assert result.brief == "Agent failed"
    records = [
        record
        for record in runtime.subagent_store.list_instances()
        if record.description == "initial failure"
    ]
    assert len(records) == 1
    assert records[0].status == "failed"


async def test_agent_tool_marks_instance_killed_when_initial_run_is_cancelled(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        raise asyncio.CancelledError()

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    with pytest.raises(asyncio.CancelledError):
        await agent_tool(
            agent_tool.params(
                description="cancelled run",
                prompt="look into parser issue",
            )
        )

    records = [
        record
        for record in runtime.subagent_store.list_instances()
        if record.description == "cancelled run"
    ]
    assert len(records) == 1
    assert records[0].status == "killed"


async def test_agent_tool_returns_rejected_by_user_when_tool_request_is_rejected(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        # Simulate the subagent continuing after a tool rejection: the LLM sees the
        # rejection and produces an assistant response instead of stopping.
        await soul.context.append_message(
            Message(
                role="assistant",
                content=[TextPart(text="x" * 250)],
            )
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    result = await agent_tool(
        agent_tool.params(
            description="rejected tool",
            prompt="look into parser issue",
        )
    )

    assert not result.is_error
    assert "status: completed" in result.output


async def test_agent_tool_rejects_subagent_runtime(agent_tool, runtime):
    runtime.role = "subagent"

    result = await agent_tool(
        agent_tool.params(
            description="delegate work",
            prompt="do something",
        )
    )

    assert result.is_error
    assert result.brief == "Agent unavailable"


async def test_agent_tool_starts_background_task(agent_tool, runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    def fake_create_agent_task(**kwargs):
        return SimpleNamespace(
            spec=SimpleNamespace(
                id="a-task-1",
                kind="agent",
                description=kwargs["description"],
            ),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="investigate bug",
                prompt="look into parser issue",
                run_in_background=True,
            )
        )

    assert not result.is_error
    assert "task_id: a-task-1" in result.output
    assert "kind: agent" in result.output
    assert "automatic_notification: true" in result.output


async def test_agent_tool_background_rejects_resume_when_instance_is_already_running(
    agent_tool, runtime, monkeypatch
):
    called = False

    def fake_create_agent_task(**kwargs):
        nonlocal called
        called = True
        return SimpleNamespace(
            spec=SimpleNamespace(id="a-task-1", kind="agent", description=kwargs["description"]),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    runtime.subagent_store.create_instance(
        agent_id="abgrunning",
        description="running instance",
        launch_spec=AgentLaunchSpec(
            agent_id="abgrunning",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    runtime.subagent_store.update_instance("abgrunning", status="running_background")

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="resume work",
                prompt="continue the previous work",
                resume="abgrunning",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Agent already running"
    assert "cannot be resumed concurrently" in result.message
    assert called is False


async def test_agent_tool_background_resume_marks_running_before_dispatch(
    agent_tool, runtime, monkeypatch
):
    """The instance must be running_background *before* create_agent_task returns
    so that a concurrent resume sees the guard immediately."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    runtime.subagent_store.create_instance(
        agent_id="aconcurr",
        description="concurrency test",
        launch_spec=AgentLaunchSpec(
            agent_id="aconcurr",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    status_during_create: list[str] = []

    def fake_create_agent_task(**kwargs):
        # Capture instance status at the moment create_agent_task is called.
        record = runtime.subagent_store.require_instance("aconcurr")
        status_during_create.append(record.status)
        return SimpleNamespace(
            spec=SimpleNamespace(id="a-task-c", kind="agent", description=kwargs["description"]),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="concurrent resume",
                prompt="do work",
                resume="aconcurr",
                run_in_background=True,
            )
        )

    assert not result.is_error
    # Instance must already be running_background when create_agent_task is called
    assert status_during_create == ["running_background"]


async def test_agent_tool_background_new_instance_marks_running_before_dispatch(
    agent_tool, runtime, monkeypatch
):
    """A fresh (non-resume) background instance must also be running_background
    before create_agent_task is called."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    status_during_create: list[str] = []
    agent_ids_seen: list[str] = []

    def fake_create_agent_task(**kwargs):
        agent_id = kwargs["agent_id"]
        agent_ids_seen.append(agent_id)
        record = runtime.subagent_store.require_instance(agent_id)
        status_during_create.append(record.status)
        return SimpleNamespace(
            spec=SimpleNamespace(id="a-task-n", kind="agent", description=kwargs["description"]),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="fresh bg",
                prompt="do work",
                run_in_background=True,
            )
        )

    assert not result.is_error
    assert status_during_create == ["running_background"]


async def test_agent_tool_background_rolls_back_status_on_dispatch_failure(
    agent_tool, runtime, monkeypatch
):
    """If create_agent_task raises for a resumed instance, the instance status
    must be rolled back to idle (not left as running_background)."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    runtime.subagent_store.create_instance(
        agent_id="arollbk1",
        description="rollback test",
        launch_spec=AgentLaunchSpec(
            agent_id="arollbk1",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    def fake_create_agent_task(**kwargs):
        raise RuntimeError("Too many background tasks are already running.")

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="rollback resume",
                prompt="continue work",
                resume="arollbk1",
                run_in_background=True,
            )
        )

    assert result.is_error
    # Instance must still exist (not deleted — it was a resume, not new)
    record = runtime.subagent_store.require_instance("arollbk1")
    # Status must be rolled back to idle, not stuck at running_background
    assert record.status == "idle"


async def test_agent_tool_background_rejects_missing_resume_instance(agent_tool, runtime):
    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="resume work",
                prompt="continue the previous work",
                resume="amissing",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Agent not found"
    assert "Subagent instance not found" in result.message


async def test_agent_tool_background_returns_tool_error_when_task_limit_is_hit(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    def fake_create_agent_task(**kwargs):
        raise RuntimeError("Too many background tasks are already running.")

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="investigate bug",
                prompt="look into parser issue",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Background start failed"
    assert "Too many background tasks are already running." in result.message


async def test_agent_tool_background_rolls_back_fresh_instance_when_task_start_fails(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    def fake_create_agent_task(**kwargs):
        raise RuntimeError("Too many background tasks are already running.")

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="rollback instance",
                prompt="look into parser issue",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Background start failed"
    assert all(
        record.description != "rollback instance"
        for record in runtime.subagent_store.list_instances()
    )


async def test_agent_tool_background_rejects_invalid_subagent_type(agent_tool, runtime):
    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="invalid type",
                prompt="do work",
                subagent_type="does-not-exist",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Invalid subagent type"
    assert "Builtin subagent type not found" in result.message


async def test_agent_tool_background_rejects_invalid_model_alias_before_start(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    called = False

    def fake_create_agent_task(**kwargs):
        nonlocal called
        called = True
        return SimpleNamespace(
            spec=SimpleNamespace(id="a-task-1", kind="agent", description=kwargs["description"]),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="invalid model",
                prompt="do work",
                subagent_type="coder",
                model="does-not-exist",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Invalid model alias"
    assert "Unknown model alias: does-not-exist" in result.message
    assert called is False


async def test_agent_tool_background_resume_rejects_invalid_model_alias_before_start(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    called = False

    def fake_create_agent_task(**kwargs):
        nonlocal called
        called = True
        return SimpleNamespace(
            spec=SimpleNamespace(id="a-task-1", kind="agent", description=kwargs["description"]),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    runtime.subagent_store.create_instance(
        agent_id="aresumebadmodel",
        description="resume bad model",
        launch_spec=AgentLaunchSpec(
            agent_id="aresumebadmodel",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="resume bad model",
                prompt="continue work",
                resume="aresumebadmodel",
                model="does-not-exist",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Invalid model alias"
    assert "Unknown model alias: does-not-exist" in result.message
    assert called is False


async def test_agent_tool_background_resume_rejects_stale_effective_model_before_start(
    agent_tool, runtime, monkeypatch
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )
    called = False

    def fake_create_agent_task(**kwargs):
        nonlocal called
        called = True
        return SimpleNamespace(
            spec=SimpleNamespace(id="a-task-1", kind="agent", description=kwargs["description"]),
            runtime=SimpleNamespace(status="starting"),
        )

    monkeypatch.setattr(runtime.background_tasks, "create_agent_task", fake_create_agent_task)

    runtime.subagent_store.create_instance(
        agent_id="astalemodel",
        description="resume stale model",
        launch_spec=AgentLaunchSpec(
            agent_id="astalemodel",
            subagent_type="coder",
            model_override=None,
            effective_model="removed-model",
        ),
    )

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="resume stale model",
                prompt="continue work",
                resume="astalemodel",
                run_in_background=True,
            )
        )

    assert result.is_error
    assert result.brief == "Invalid model alias"
    assert "Unknown model alias: removed-model" in result.message
    assert called is False


async def test_agent_tool_background_agent_waits_for_approval(agent_tool, runtime, monkeypatch):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        source = get_current_approval_source_or_none()
        assert source is not None
        request = soul.runtime.approval_runtime.create_request(
            request_id="req-bg-approval",
            tool_call_id="call-bg-approval",
            sender="WriteFile",
            action="edit file",
            description="Edit target file",
            display=[],
            source=source,
        )
        await soul.runtime.approval_runtime.wait_for_response(request.id)
        # Use a response >= SUMMARY_MIN_LENGTH to avoid triggering summary continuation.
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="x" * 250)])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    queue = runtime.root_wire_hub.subscribe()
    try:
        with tool_call_context("Agent"):
            result = await agent_tool(
                agent_tool.params(
                    description="investigate bug",
                    prompt="look into parser issue",
                    run_in_background=True,
                )
            )

        assert not result.is_error
        task_id = _extract_task_id(result.output)
        msg = await queue.get()
        assert isinstance(msg, ApprovalRequest)
        assert msg.id == "req-bg-approval"
        assert msg.source_kind == "background_agent"
        assert msg.source_id == task_id

        view = None
        for _ in range(20):
            view = runtime.background_tasks.get_task(task_id)
            assert view is not None
            if view.runtime.status == "awaiting_approval":
                break
            import asyncio

            await asyncio.sleep(0.01)
        assert view is not None
        assert view.runtime.status == "awaiting_approval"

        assert runtime.approval_runtime is not None
        runtime.approval_runtime.resolve("req-bg-approval", "approve")
        waited = await runtime.background_tasks.wait(task_id, timeout_s=2)
        assert waited.runtime.status == "completed"
    finally:
        assert runtime.root_wire_hub is not None
        runtime.root_wire_hub.unsubscribe(queue)


async def test_task_stop_kills_background_agent_waiting_for_approval(
    agent_tool, runtime, monkeypatch, task_stop_tool
):
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        source = get_current_approval_source_or_none()
        assert source is not None
        soul.runtime.approval_runtime.create_request(
            request_id="req-bg-stop",
            tool_call_id="call-bg-stop",
            sender="WriteFile",
            action="edit file",
            description="Edit target file",
            display=[],
            source=source,
        )
        await soul.runtime.approval_runtime.wait_for_response("req-bg-stop")

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    with tool_call_context("Agent"):
        result = await agent_tool(
            agent_tool.params(
                description="investigate bug",
                prompt="look into parser issue",
                run_in_background=True,
            )
        )

    assert not result.is_error
    task_id = _extract_task_id(result.output)

    import asyncio

    view = None
    for _ in range(20):
        view = runtime.background_tasks.get_task(task_id)
        assert view is not None
        if view.runtime.status == "awaiting_approval":
            break
        await asyncio.sleep(0.01)
    assert view is not None
    assert view.runtime.status == "awaiting_approval"

    stop_result = await task_stop_tool(task_stop_tool.params(task_id=task_id))

    assert not stop_result.is_error
    killed_view = runtime.background_tasks.get_task(task_id)
    assert killed_view is not None
    assert killed_view.runtime.status == "killed"
    assert runtime.approval_runtime.list_pending() == []


async def test_foreground_agent_explicit_timeout_returns_tool_error(
    agent_tool, runtime, monkeypatch
):
    """When the model passes an explicit timeout for a foreground agent and the
    subagent exceeds it, the tool should return a ToolError (not hang)."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul_hang(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        # Simulate a subagent that never finishes
        await asyncio.Event().wait()

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul_hang)

    import time

    params = agent_tool.params(
        description="slow task",
        prompt="do something slow",
        timeout=30,
    )
    # Override to a short timeout so the test doesn't actually wait 30s
    object.__setattr__(params, "timeout", 1)

    start = time.monotonic()
    result = await agent_tool(params)
    elapsed = time.monotonic() - start

    # Should be a ToolError, not a hang; and should finish quickly
    assert result.is_error
    assert "timed out" in result.message.lower()
    assert elapsed < 5.0


async def test_foreground_agent_internal_timeout_with_explicit_deadline(
    agent_tool, runtime, monkeypatch
):
    """When an explicit timeout IS set but an internal TimeoutError fires first,
    it should still be reported as a generic failure, not 'Agent timed out after Xs'."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul_internal_timeout(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        raise TimeoutError("aiohttp sock_read timeout")

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul_internal_timeout)

    params = agent_tool.params(
        description="internal timeout with deadline",
        prompt="do something",
        timeout=600,
    )

    result = await agent_tool(params)

    assert result.is_error
    # Must be generic failure, NOT "Agent timed out after 600s"
    assert "timed out" not in result.message.lower()
    assert "Failed to run agent" in result.message
