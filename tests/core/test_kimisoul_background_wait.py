"""Tests for agent loop behavior when background tasks are active.

The agent loop should NOT exit when the LLM produces a text-only response
(no tool calls) while background tasks are still running. Instead, it should
wait for background task completions and continue the loop.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import pytest
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.background.models import TaskRuntime, TaskSpec, TaskStatus
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import TextPart


@pytest.fixture
def approval():
    from kimi_cli.soul.approval import Approval

    return Approval(yolo=True)


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Background Wait Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _create_fake_task(manager, task_id: str, status: TaskStatus = "running") -> None:
    """Create a fake task entry in the background task store."""
    spec = TaskSpec(
        id=task_id,
        kind="agent",
        session_id="test",
        description=f"Test task {task_id}",
        tool_call_id=f"call-{task_id}",
        owner_role="root",
    )
    runtime = TaskRuntime(status=status)
    manager.store.task_dir(task_id)  # ensure directory exists
    manager.store.write_spec(spec)
    manager.store.write_runtime(task_id, runtime)


@pytest.mark.asyncio
async def test_agent_loop_waits_for_background_tasks_before_exiting(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When background tasks are active and LLM returns no tool calls,
    the agent loop should wait for background task completion instead of exiting.

    This test reproduces the bug where the agent loop exits prematurely
    because it only checks for steers, not pending background tasks.
    """
    soul = _make_soul(runtime, tmp_path)
    step_calls = 0

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    manager = runtime.background_tasks
    # Create two fake running background tasks
    _create_fake_task(manager, "agent-task1", "running")
    _create_fake_task(manager, "agent-task2", "running")

    async def fake_step():
        nonlocal step_calls
        step_calls += 1

        if step_calls == 1:
            # First step: LLM says "waiting for tasks" with no tool calls.
            # There are 2 active background tasks, so loop should NOT exit.
            return kimisoul_module.StepOutcome(
                stop_reason="no_tool_calls",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="Waiting for background tasks to finish...")],
                ),
            )

        if step_calls == 2:
            # Second step: triggered by task1 completion.
            # task2 is still running → loop waits again.
            return kimisoul_module.StepOutcome(
                stop_reason="no_tool_calls",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="Task 1 done, waiting for task 2...")],
                ),
            )

        if step_calls == 3:
            # Third step: triggered by task2 completion.
            # No more active tasks → loop exits normally.
            return kimisoul_module.StepOutcome(
                stop_reason="no_tool_calls",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="All tasks done!")],
                ),
            )

        pytest.fail("Should not reach step 4")

    monkeypatch.setattr(soul, "_step", fake_step)

    # Schedule background task completions with enough gap between them
    # so each completion triggers a separate step.
    async def simulate_completions():
        await asyncio.sleep(0.05)
        # First task completes → set completion event → triggers step 2
        store = manager.store
        rt = store.read_runtime("agent-task1")
        rt.status = "completed"
        store.write_runtime("agent-task1", rt)
        manager.completion_event.set()

        await asyncio.sleep(0.5)
        # Second task completes → set completion event → triggers step 3
        rt = store.read_runtime("agent-task2")
        rt.status = "completed"
        store.write_runtime("agent-task2", rt)
        manager.completion_event.set()

    completion_task = asyncio.create_task(simulate_completions())

    try:
        outcome = await asyncio.wait_for(soul._agent_loop(), timeout=5.0)
    except TimeoutError:
        pytest.fail("agent_loop timed out — it may be stuck waiting indefinitely")
    finally:
        completion_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await completion_task

    # Each completion triggers one new step. With 2 tasks:
    # step 1 (initial) + step 2 (task1 done) + step 3 (task2 done) = 3 steps.
    # Without the fix, it would exit after step 1 (step_calls == 1).
    assert step_calls == 3, (
        f"Expected 3 steps (one per background task completion), "
        f"but got {step_calls}. The loop likely exited prematurely."
    )
    assert outcome.stop_reason == "no_tool_calls"


@pytest.mark.asyncio
async def test_agent_loop_exits_normally_when_no_background_tasks(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When no background tasks are active and LLM returns no tool calls,
    the loop should exit normally (existing behavior preserved)."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    async def fake_step():
        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(
                role="assistant",
                content=[TextPart(text="Done, no background tasks.")],
            ),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    outcome = await soul._agent_loop()

    assert outcome.stop_reason == "no_tool_calls"
    assert outcome.step_count == 1


@pytest.mark.asyncio
async def test_agent_loop_background_wait_respects_cancellation(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When waiting for background tasks, the loop should be cancellable
    (e.g., via Ctrl+C / asyncio.CancelledError)."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    manager = runtime.background_tasks
    _create_fake_task(manager, "agent-hanging", "running")

    async def fake_step():
        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(
                role="assistant",
                content=[TextPart(text="Waiting...")],
            ),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    # The loop should be waiting for background tasks.
    # Cancel it after a short delay.
    loop_task = asyncio.create_task(soul._agent_loop())
    await asyncio.sleep(0.1)
    loop_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await loop_task


@pytest.mark.asyncio
async def test_agent_loop_exits_when_tasks_complete_between_checks(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If all background tasks complete between the first has_active_tasks()
    check and the re-check after event.clear(), the loop should exit normally
    instead of waiting forever."""
    soul = _make_soul(runtime, tmp_path)
    step_calls = 0

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    manager = runtime.background_tasks
    _create_fake_task(manager, "agent-fast", "running")

    has_active_call_count = 0

    def patched_has_active_tasks():
        nonlocal has_active_call_count
        has_active_call_count += 1
        if has_active_call_count == 1:
            return True  # first check: still active
        # Between checks, the task completed
        store = manager.store
        rt = store.read_runtime("agent-fast")
        rt.status = "completed"
        store.write_runtime("agent-fast", rt)
        return False  # re-check: no longer active

    monkeypatch.setattr(manager, "has_active_tasks", patched_has_active_tasks)

    async def fake_step():
        nonlocal step_calls
        step_calls += 1
        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(
                role="assistant",
                content=[TextPart(text="Done")],
            ),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    outcome = await asyncio.wait_for(soul._agent_loop(), timeout=2.0)

    assert step_calls == 1
    assert outcome.stop_reason == "no_tool_calls"


@pytest.mark.asyncio
async def test_agent_loop_background_wait_handles_steer(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When waiting for background tasks, a steer from the user should
    break the wait and let the loop continue so the steer is processed."""
    soul = _make_soul(runtime, tmp_path)
    step_calls = 0

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    manager = runtime.background_tasks
    _create_fake_task(manager, "agent-slow", "running")

    async def fake_step():
        nonlocal step_calls
        step_calls += 1

        if step_calls == 1:
            # LLM returns text, bg task still running → enters wait loop
            return kimisoul_module.StepOutcome(
                stop_reason="no_tool_calls",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="Waiting...")],
                ),
            )

        # step 2: steer was consumed, bg task completes, loop exits
        store = manager.store
        rt = store.read_runtime("agent-slow")
        rt.status = "completed"
        store.write_runtime("agent-slow", rt)

        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(
                role="assistant",
                content=[TextPart(text="Done after steer")],
            ),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    # After a short delay, send a steer — this should break the bg wait
    async def send_steer():
        await asyncio.sleep(0.1)
        soul.steer("stop and do something else")

    steer_task = asyncio.create_task(send_steer())

    try:
        await asyncio.wait_for(soul._agent_loop(), timeout=5.0)
    except TimeoutError:
        pytest.fail("agent_loop timed out — steer was not picked up during bg wait")
    finally:
        steer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await steer_task

    # The steer should have broken the wait, causing step 2 to run
    assert step_calls == 2, f"Expected 2 steps (wait interrupted by steer), got {step_calls}"


@pytest.mark.asyncio
async def test_agent_loop_tool_rejected_exits_despite_background_tasks(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the LLM's tool call is rejected (stop_reason='tool_rejected'),
    the loop should exit immediately even if background tasks are still running.
    The background wait logic only applies to 'no_tool_calls'."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    manager = runtime.background_tasks
    _create_fake_task(manager, "agent-running", "running")

    async def fake_step():
        return kimisoul_module.StepOutcome(
            stop_reason="tool_rejected",
            assistant_message=Message(
                role="assistant",
                content=[TextPart(text="Tool was rejected.")],
            ),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    outcome = await asyncio.wait_for(soul._agent_loop(), timeout=2.0)

    # Should exit immediately with tool_rejected, not wait for bg tasks
    assert outcome.stop_reason == "tool_rejected"


@pytest.mark.asyncio
async def test_agent_loop_skips_wait_when_event_already_set(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When completion_event is already set (a task completed during _step()),
    the loop should skip the timed wait and immediately continue to the next
    step to process the pending notification."""
    soul = _make_soul(runtime, tmp_path)
    step_calls = 0

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: None)

    manager = runtime.background_tasks
    _create_fake_task(manager, "agent-fast", "running")
    _create_fake_task(manager, "agent-slow", "running")

    async def fake_step():
        nonlocal step_calls
        step_calls += 1

        if step_calls == 1:
            # Simulate: task-fast completed during this step, pump set event.
            store = manager.store
            rt = store.read_runtime("agent-fast")
            rt.status = "completed"
            store.write_runtime("agent-fast", rt)
            manager.completion_event.set()

            return kimisoul_module.StepOutcome(
                stop_reason="no_tool_calls",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="Waiting...")],
                ),
            )

        if step_calls == 2:
            # Step 2 should run immediately (no 2s delay) because
            # event was already set. Mark slow task done so loop exits.
            store = manager.store
            rt = store.read_runtime("agent-slow")
            rt.status = "completed"
            store.write_runtime("agent-slow", rt)

            return kimisoul_module.StepOutcome(
                stop_reason="no_tool_calls",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="All done")],
                ),
            )

        pytest.fail("Should not reach step 3")

    monkeypatch.setattr(soul, "_step", fake_step)

    import time

    start = time.monotonic()
    outcome = await asyncio.wait_for(soul._agent_loop(), timeout=5.0)
    elapsed = time.monotonic() - start

    assert step_calls == 2
    assert outcome.stop_reason == "no_tool_calls"
    # Should complete well under 2s (the wait timeout) since the event
    # was already set and the fast path skipped the timed wait.
    assert elapsed < 1.0, (
        f"Loop took {elapsed:.1f}s — it should have skipped the 2s wait "
        f"because completion_event was already set"
    )
