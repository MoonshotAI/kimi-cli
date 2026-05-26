from __future__ import annotations

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
