"""
Integration tests for the background agent kill (TaskStop) path.

Verifies that:
  1. A running background agent can be stopped via manager.kill()
  2. Subagent status transitions to 'killed'
  3. Task runtime status transitions to 'killed' with correct failure_reason
  4. Pending approvals belonging to the killed agent are cancelled
  5. The agent runner cleans up properly (output file, live_agent_tasks)
"""

from __future__ import annotations

import asyncio
import time

import pytest
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.approval_runtime import ApprovalSource
from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.subagents import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy
from kimi_cli.wire.types import TextPart


def _register_coder(runtime) -> None:
    if runtime.labor_market.get_builtin_type("coder") is not None:
        return
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="General purpose coding agent.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )


def _create_bg_agent_instance(runtime, agent_id: str = "akill01") -> str:
    """Create a coder subagent instance in idle state."""
    runtime.subagent_store.create_instance(
        agent_id=agent_id,
        description="killable agent",
        launch_spec=AgentLaunchSpec(
            agent_id=agent_id,
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    return agent_id


# ---------------------------------------------------------------------------
# Test 1: Kill a background agent that is blocked in run_soul
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kill_background_agent_during_soul_run(runtime, monkeypatch):
    """When a background agent is executing run_soul and we call manager.kill(),
    the agent should transition to 'killed' in both task runtime and subagent store."""
    _register_coder(runtime)
    agent_id = _create_bg_agent_instance(runtime)

    # Make run_soul block forever until cancelled.
    soul_started = asyncio.Event()

    async def fake_load_agent(agent_file, rt, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="bg test",
            toolset=EmptyToolset(),
            runtime=rt,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        soul_started.set()
        # Block forever — will be cancelled by task.cancel().
        await asyncio.Future()

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    # Create a background task via the manager.
    runtime.background_tasks.bind_runtime(runtime)
    view = runtime.background_tasks.create_agent_task(
        agent_id=agent_id,
        subagent_type="coder",
        prompt="do something long",
        description="killable",
        tool_call_id="tc-kill-1",
        model_override=None,
    )
    task_id = view.spec.id

    # Wait for run_soul to actually start (the agent is blocked inside).
    try:
        await asyncio.wait_for(soul_started.wait(), timeout=10.0)
    except TimeoutError:
        pytest.fail("Background agent did not start run_soul within 10 seconds")

    # Now kill the task.
    runtime.background_tasks.kill(task_id, reason="test kill")

    # Give the cancellation a moment to propagate through the asyncio task.
    await asyncio.sleep(0.3)

    # Verify task runtime status.
    final_view = runtime.background_tasks.get_task(task_id)
    assert final_view is not None
    assert final_view.runtime.status == "killed", (
        f"Expected task status 'killed', got '{final_view.runtime.status}'"
    )
    # manager.kill() sets failure_reason first; the agent_runner's
    # CancelledError handler also calls _mark_task_killed but the
    # terminal-status guard skips the second write, preserving the
    # caller's original reason.
    assert final_view.runtime.failure_reason == "test kill"
    assert final_view.runtime.interrupted is True
    assert final_view.runtime.finished_at is not None

    # Verify subagent store status.
    record = runtime.subagent_store.require_instance(agent_id)
    assert record.status == "killed", f"Expected subagent status 'killed', got '{record.status}'"

    # Verify the agent task was removed from live_agent_tasks.
    assert task_id not in runtime.background_tasks._live_agent_tasks


# ---------------------------------------------------------------------------
# Test 2: Kill cancels pending approval requests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kill_cancels_pending_approvals(runtime, monkeypatch):
    """When a background agent has a pending approval and is killed,
    the approval should be cancelled."""
    _register_coder(runtime)
    agent_id = _create_bg_agent_instance(runtime)

    approval_blocked = asyncio.Event()

    async def fake_load_agent(agent_file, rt, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="approval test",
            toolset=EmptyToolset(),
            runtime=rt,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        # Simulate creating an approval request and blocking on it.
        approval_blocked.set()
        await asyncio.Future()  # Block forever.

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    runtime.background_tasks.bind_runtime(runtime)
    view = runtime.background_tasks.create_agent_task(
        agent_id=agent_id,
        subagent_type="coder",
        prompt="approval task",
        description="approval test",
        tool_call_id="tc-appr-kill",
        model_override=None,
    )
    task_id = view.spec.id

    await asyncio.wait_for(approval_blocked.wait(), timeout=5.0)

    # Create a fake pending approval belonging to this background agent.
    approval_req = runtime.approval_runtime.create_request(
        sender="Shell",
        action="run command",
        description="rm -rf /",
        tool_call_id="tc-fake-appr",
        display=[],
        source=ApprovalSource(
            kind="background_agent",
            id=task_id,
            agent_id=agent_id,
            subagent_type="coder",
        ),
    )
    assert runtime.approval_runtime.get_request(approval_req.id).status == "pending"

    # Kill the task — should cancel the pending approval.
    runtime.background_tasks.kill(task_id, reason="cancel approvals test")
    await asyncio.sleep(0.3)

    # Verify the approval was cancelled.
    req_after = runtime.approval_runtime.get_request(approval_req.id)
    assert req_after.status == "cancelled", (
        f"Expected approval status 'cancelled', got '{req_after.status}'"
    )


# ---------------------------------------------------------------------------
# Test 3: Kill an already-completed task is a no-op
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kill_completed_task_is_noop(runtime, monkeypatch):
    """Calling kill on a task that already completed should return the current
    view without changing anything — the terminal status guard should trigger."""
    _register_coder(runtime)
    agent_id = _create_bg_agent_instance(runtime)

    long = "x" * 250

    async def fake_load_agent(agent_file, rt, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="noop test",
            toolset=EmptyToolset(),
            runtime=rt,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        await soul.context.append_message(Message(role="assistant", content=[TextPart(text=long)]))

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    runtime.background_tasks.bind_runtime(runtime)
    view = runtime.background_tasks.create_agent_task(
        agent_id=agent_id,
        subagent_type="coder",
        prompt="quick task",
        description="quick",
        tool_call_id="tc-noop",
        model_override=None,
    )
    task_id = view.spec.id

    # Wait for the task to complete.
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        v = runtime.background_tasks.get_task(task_id)
        if v is not None and v.runtime.status == "completed":
            break
        await asyncio.sleep(0.1)
    else:
        pytest.fail("Background task did not complete within 10 seconds")

    # Now try to kill it.
    kill_view = runtime.background_tasks.kill(task_id, reason="too late")

    # Should still be completed, not killed.
    assert kill_view.runtime.status == "completed"
    assert kill_view.runtime.failure_reason is None

    # Subagent should be idle (completed bg returns to idle).
    record = runtime.subagent_store.require_instance(agent_id)
    assert record.status == "idle"
