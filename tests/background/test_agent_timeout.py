"""Tests for background agent task timeout."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock

import pytest

from kimi_cli.background import TaskSpec
from kimi_cli.background.agent_runner import BackgroundAgentRunner


@pytest.fixture
def mock_runner(runtime):
    """Create a BackgroundAgentRunner with mocked internals."""
    manager = runtime.background_tasks
    manager._runtime = runtime

    # Pre-create task in the store so _mark_task_failed can write to it
    task_id = "agent-timeout-test"
    store = manager.store
    spec = TaskSpec(
        id=task_id,
        kind="agent",
        session_id=runtime.session.id,
        description="timeout test",
        tool_call_id="tool-t",
        owner_role="root",
    )
    store.create_task(spec)

    # Create a minimal subagent store mock
    runtime.subagent_store = MagicMock()
    runtime.subagent_store.output_path.return_value = store._root / "output.txt"
    runtime.subagent_store.output_path.return_value.parent.mkdir(parents=True, exist_ok=True)
    runtime.subagent_store.context_path.return_value = store._root / "ctx"
    runtime.subagent_store.wire_path.return_value = store._root / "wire.jsonl"
    runtime.subagent_store.prompt_path.return_value = MagicMock()
    runtime.subagent_store.require_instance.return_value = MagicMock(
        launch_spec=MagicMock(
            model_override=None,
            effective_model=None,
        )
    )

    return BackgroundAgentRunner(
        runtime=runtime,
        manager=manager,
        task_id=task_id,
        agent_id="a_test123",
        subagent_type="mocker",
        prompt="test prompt",
        model_override=None,
        timeout_s=2,  # 2-second timeout for testing
    )


async def test_background_agent_timeout(mock_runner, runtime):
    """A background agent that hangs should be stopped by timeout."""
    hang_forever = asyncio.Event()

    async def _hang(*args, **kwargs):
        await hang_forever.wait()

    mock_runner._run_core = _hang

    start = time.monotonic()
    await mock_runner.run()
    elapsed = time.monotonic() - start

    # Should have timed out in ~2 seconds, not hung forever
    assert elapsed < 5.0

    # Task should be marked as failed with timed_out semantics
    store = runtime.background_tasks.store
    rt = store.read_runtime("agent-timeout-test")
    assert rt.status == "failed"
    assert rt.timed_out is True
    assert rt.interrupted is True
    assert "timed out" in (rt.failure_reason or "")


async def test_background_agent_no_timeout(runtime):
    """When timeout_s is None, no timeout wrapper is applied."""
    manager = runtime.background_tasks
    manager._runtime = runtime
    runtime.subagent_store = MagicMock()

    runner = BackgroundAgentRunner(
        runtime=runtime,
        manager=manager,
        task_id="agent-no-timeout",
        agent_id="a_notime",
        subagent_type="mocker",
        prompt="test",
        model_override=None,
        timeout_s=None,
    )

    completed = asyncio.Event()

    async def _fast_core(*args, **kwargs):
        completed.set()

    runner._run_core = _fast_core
    await runner.run()
    assert completed.is_set()


async def test_background_agent_internal_timeout_with_deadline_set(runtime):
    """Production path: timeout_s is set (e.g. 900) but an internal TimeoutError
    (e.g. aiohttp sock_read) fires first. Should be generic failure, NOT timed_out."""
    manager = runtime.background_tasks
    manager._runtime = runtime

    task_id = "agent-deadln01"
    store = manager.store
    spec = TaskSpec(
        id=task_id,
        kind="agent",
        session_id=runtime.session.id,
        description="internal timeout with deadline",
        tool_call_id="tool-id",
        owner_role="root",
    )
    store.create_task(spec)

    runtime.subagent_store = MagicMock()
    runtime.subagent_store.output_path.return_value = store._root / "output2.txt"
    runtime.subagent_store.output_path.return_value.parent.mkdir(parents=True, exist_ok=True)

    runner = BackgroundAgentRunner(
        runtime=runtime,
        manager=manager,
        task_id=task_id,
        agent_id="a_prod",
        subagent_type="mocker",
        prompt="test",
        model_override=None,
        timeout_s=900,  # Production default — deadline IS set
    )

    async def _raise_internal_timeout(*args, **kwargs):
        raise TimeoutError("aiohttp sock_read timeout")

    runner._run_core = _raise_internal_timeout
    await runner.run()

    # Internal timeout should be generic failure, NOT timed_out
    rt = store.read_runtime(task_id)
    assert rt.status == "failed"
    assert rt.timed_out is not True
    assert "aiohttp" in (rt.failure_reason or "")
