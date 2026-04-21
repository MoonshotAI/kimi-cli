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
# Regression: kill() must not drop the only strong reference to the asyncio
# task. asyncio holds tasks in a WeakSet, so dropping the strong reference
# before cancellation has propagated lets Python's GC collect the still-pending
# task — which fires loop.call_exception_handler with no 'exception' field.
# prompt_toolkit then surfaces this as
# "Unhandled exception in event loop: Exception None / Press ENTER to continue".
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kill_keeps_strong_reference_until_runner_finishes(runtime, monkeypatch):
    """kill() must keep the asyncio.Task in _live_agent_tasks until the runner's
    finally block removes it, so the cancellation can propagate without the
    task being garbage-collected mid-flight."""
    import gc
    import weakref

    _register_coder(runtime)
    agent_id = _create_bg_agent_instance(runtime, agent_id="agcrace1")

    soul_started = asyncio.Event()

    async def fake_load_agent(agent_file, rt, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="gc race test",
            toolset=EmptyToolset(),
            runtime=rt,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        soul_started.set()
        await asyncio.Future()  # Block forever; cancellation will unblock us.

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    runtime.background_tasks.bind_runtime(runtime)
    view = runtime.background_tasks.create_agent_task(
        agent_id=agent_id,
        subagent_type="coder",
        prompt="block forever",
        description="gc race",
        tool_call_id="tc-gc-race",
        model_override=None,
    )
    task_id = view.spec.id

    try:
        await asyncio.wait_for(soul_started.wait(), timeout=10.0)
    except TimeoutError:
        pytest.fail("Background agent did not start run_soul within 10 seconds")

    # Capture the live task object and a weakref before kill(). The id() is
    # used to assert object identity after kill() — we want to be sure the
    # *same* task object is still held, not just that some entry exists.
    live_task_before = runtime.background_tasks._live_agent_tasks[task_id]
    live_task_id_before = id(live_task_before)
    task_ref = weakref.ref(live_task_before)
    del live_task_before

    # Trigger the kill. Under the bug, kill() pops the only strong reference
    # to the task and returns immediately, leaving the task reachable only via
    # asyncio's WeakSet. Once Python's GC runs, the still-pending task is
    # collected and Task.__del__ fires the loop exception handler with no
    # 'exception' field — exactly the "Exception None" symptom users see.
    runtime.background_tasks.kill(task_id, reason="gc race")

    # Primary invariant: immediately after kill() returns, _live_agent_tasks
    # must still hold the *same* task object. Only the runner's finally block
    # (which runs after cancellation has propagated) is allowed to remove it.
    # This is the contract that prevents the GC race regardless of interpreter
    # GC details.
    assert task_id in runtime.background_tasks._live_agent_tasks, (
        "kill() dropped the strong reference to the asyncio.Task before "
        "cancellation propagated. asyncio holds only weak references to tasks; "
        "the runner's finally block must be the one to clear _live_agent_tasks."
    )
    assert id(runtime.background_tasks._live_agent_tasks[task_id]) == live_task_id_before, (
        "kill() replaced the asyncio.Task in _live_agent_tasks instead of "
        "preserving the original strong reference."
    )

    # Secondary canary: with the strong reference still in the dict, the task
    # must survive a forced collection cycle. This is implementation-detail
    # sensitive (depends on CPython's GC behavior for cycles), so it is a
    # best-effort additional check rather than the primary contract.
    gc.collect()
    assert task_ref() is not None, (
        "Background agent asyncio.Task was garbage-collected after kill() "
        "even though _live_agent_tasks should still hold it."
    )

    # Now let the cancellation actually propagate; the runner's finally block
    # is responsible for removing the entry from _live_agent_tasks.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if task_id not in runtime.background_tasks._live_agent_tasks:
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("Runner finally block did not clear _live_agent_tasks in time")


# ---------------------------------------------------------------------------
# Regression: kill() must clean up _live_agent_tasks even when the runner
# coroutine is cancelled before its first event-loop step. In that case
# `coro.throw(CancelledError)` into a FRAME_CREATED coroutine completes it
# without executing the function body — the runner's `finally` block never
# runs, so it cannot be the only place that pops the dict entry. The cleanup
# must come from a task done callback wired up at task creation time.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kill_before_runner_starts_cleans_up_live_tasks(runtime, monkeypatch):
    """If kill() is called in the same event-loop turn as create_agent_task(),
    the runner coroutine is cancelled before it has a chance to take its first
    step. Python throws CancelledError into the never-started coroutine, which
    transitions to COMPLETED without executing any of the function body —
    including the finally block. _live_agent_tasks must still be cleaned up
    via a task done callback registered at creation time."""
    _register_coder(runtime)
    agent_id = _create_bg_agent_instance(runtime, agent_id="anvrstrt")

    runner_body_started = asyncio.Event()

    async def fake_load_agent(agent_file, rt, *, mcp_configs, start_mcp_loading=True):
        # Reaching this proves the runner body executed — we want to assert
        # the opposite, so flip the flag if we ever get here.
        runner_body_started.set()
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="never started",
            toolset=EmptyToolset(),
            runtime=rt,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        await asyncio.Future()  # Would block forever if reached.

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    runtime.background_tasks.bind_runtime(runtime)

    # Create the background agent task and IMMEDIATELY kill it without
    # yielding to the event loop in between. The runner coroutine has been
    # scheduled (loop.call_soon for its first __step) but has not yet executed.
    view = runtime.background_tasks.create_agent_task(
        agent_id=agent_id,
        subagent_type="coder",
        prompt="never starts",
        description="never started",
        tool_call_id="tc-never-start",
        model_override=None,
    )
    task_id = view.spec.id

    # Sanity: the task should be in the dict and the runner body should not
    # have run yet (we have not yielded to the loop).
    assert task_id in runtime.background_tasks._live_agent_tasks
    assert not runner_body_started.is_set()

    # Kill before the runner has had any chance to start its first step.
    runtime.background_tasks.kill(task_id, reason="kill before start")

    # Yield to the loop several times so asyncio can:
    #   1. Process the runner task's scheduled __step (which sees must_cancel
    #      and throws CancelledError into the FRAME_CREATED coroutine)
    #   2. Mark the task DONE
    #   3. Schedule and fire its done callbacks
    for _ in range(5):
        await asyncio.sleep(0)

    # The runner body must NOT have executed — this is the precondition that
    # makes this test exercise the never-started cancellation path. If this
    # fails, the test setup is wrong and the assertion below would not be
    # meaningful.
    assert not runner_body_started.is_set(), (
        "Runner coroutine started before kill() — test setup is wrong, "
        "this scenario cannot exercise the never-started cancellation path"
    )

    # Despite the runner's finally block never running, the entry must have
    # been cleaned up from _live_agent_tasks. Cleanup must come from a task
    # done callback registered at creation time, because the finally block
    # is no longer reachable on this path.
    assert task_id not in runtime.background_tasks._live_agent_tasks, (
        "_live_agent_tasks still holds the cancelled-before-start task — "
        "the runner's finally block never ran on this path. create_agent_task "
        "must register a task done callback so the dict entry is cleaned up "
        "regardless of how the task terminates."
    )


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
