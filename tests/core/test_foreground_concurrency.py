from __future__ import annotations

import contextlib

from kosong.tooling import ToolReturnValue

from kimi_cli.llm_key_pool import APIKeyPool
from kimi_cli.subagents.models import (
    AgentLaunchSpec,
    AgentTypeDefinition,
    ToolPolicy,
)
from kimi_cli.tools.agent import _count_running_foreground, _max_foreground_concurrency


class TestMaxForegroundConcurrency:
    def test_key_pool_based_limit(self, runtime):
        runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
        assert _max_foreground_concurrency(runtime) == 4  # 5 * 0.8 = 4

    def test_key_pool_single_key_fallback_to_one(self, runtime):
        runtime.key_pool = APIKeyPool(["k1"])
        assert _max_foreground_concurrency(runtime) == 1  # 1 * 0.8 -> max(1, 0) = 1

    def test_no_key_pool_uses_max_running_tasks(self, runtime):
        runtime.key_pool = None
        runtime.config.background.max_running_tasks = 5
        assert _max_foreground_concurrency(runtime) == 4  # 5 * 0.8 = 4

    def test_no_key_pool_min_one(self, runtime):
        runtime.key_pool = None
        runtime.config.background.max_running_tasks = 1
        assert _max_foreground_concurrency(runtime) == 1  # 1 * 0.8 -> max(1, 0) = 1


class TestCountRunningForeground:
    def test_empty_store(self, runtime):
        assert _count_running_foreground(runtime) == 0

    def test_counts_only_running_foreground(self, runtime):
        store = runtime.subagent_store
        assert store is not None

        store.create_instance(
            agent_id="a1",
            description="running",
            launch_spec=AgentLaunchSpec(
                agent_id="a1", subagent_type="coder", model_override=None, effective_model=None
            ),
        )
        store.update_instance("a1", status="running_foreground")

        store.create_instance(
            agent_id="a2",
            description="idle",
            launch_spec=AgentLaunchSpec(
                agent_id="a2", subagent_type="coder", model_override=None, effective_model=None
            ),
        )

        store.create_instance(
            agent_id="a3",
            description="failed",
            launch_spec=AgentLaunchSpec(
                agent_id="a3", subagent_type="coder", model_override=None, effective_model=None
            ),
        )
        store.update_instance("a3", status="failed")

        assert _count_running_foreground(runtime) == 1


async def test_agent_tool_rejects_when_concurrency_limit_reached(agent_tool, runtime):
    """When the foreground concurrency limit is reached, new requests are rejected."""

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    # Set a very low limit (1) so we can hit it easily
    runtime.config.background.max_running_tasks = 1
    runtime.key_pool = None

    # Create a fake running foreground instance
    store = runtime.subagent_store
    store.create_instance(
        agent_id="a_running",
        description="already running",
        launch_spec=AgentLaunchSpec(
            agent_id="a_running", subagent_type="coder", model_override=None, effective_model=None
        ),
    )
    store.update_instance("a_running", status="running_foreground")

    params = agent_tool.params(
        description="new task",
        prompt="do something",
    )

    result = await agent_tool(params)

    assert result.is_error
    assert "concurrency limit reached" in result.brief.lower()
    assert "1/1" in result.message


async def test_agent_tool_eagerly_sets_running_foreground_before_await(
    agent_tool, runtime, monkeypatch
):
    """After the TOCTOU fix, the instance status must be running_foreground BEFORE runner.run is awaited."""

    from kosong.tooling import ToolOk

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    runtime.config.background.max_running_tasks = 10
    runtime.key_pool = None

    captured_statuses = []

    async def patched_run(self, req, prepared=None):
        assert prepared is not None
        store = self._runtime.subagent_store
        assert store is not None
        inst = store.get_instance(prepared.record.agent_id)
        if inst is not None:
            captured_statuses.append(inst.status)
        else:
            captured_statuses.append(None)
        return ToolOk(output="done")

    monkeypatch.setattr("kimi_cli.subagents.runner.ForegroundSubagentRunner.run", patched_run)

    params = agent_tool.params(description="task", prompt="do something")
    await agent_tool(params)

    assert captured_statuses == ["running_foreground"]


async def test_concurrent_agent_calls_respect_limit_after_toctou_fix(
    agent_tool, runtime, monkeypatch
):
    """Concurrent Agent tool calls should not exceed the limit because status is set eagerly."""
    import asyncio

    from kimi_cli.subagents.runner import ForegroundSubagentRunner

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    runtime.config.background.max_running_tasks = 1
    runtime.key_pool = None

    class HangingRunner(ForegroundSubagentRunner):
        async def run(self, req, prepared=None) -> ToolReturnValue:
            await asyncio.Event().wait()
            return ToolReturnValue(is_error=False, output="", message="", display=[])

    monkeypatch.setattr("kimi_cli.tools.agent.ForegroundSubagentRunner", HangingRunner)

    params1 = agent_tool.params(description="task1", prompt="do something")
    params2 = agent_tool.params(description="task2", prompt="do something else")

    task1 = asyncio.create_task(agent_tool(params1))
    # Yield so task1 gets through prepare_instance + update_instance
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    result2 = await agent_tool(params2)

    task1.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task1

    assert result2.is_error
    assert "concurrency limit reached" in result2.brief.lower()
