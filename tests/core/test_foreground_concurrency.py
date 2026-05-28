from __future__ import annotations

import contextlib
from pathlib import Path

from kosong.tooling import ToolReturnValue
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm_key_pool import APIKeyPool
from kimi_cli.subagents.models import (
    AgentLaunchSpec,
    AgentTypeDefinition,
    ToolPolicy,
)
from kimi_cli.tools.agent import (
    _count_running_foreground,
    _max_foreground_concurrency,
)


class TestMaxForegroundConcurrency:
    def test_key_pool_based_limit_for_kimi(self, runtime):
        runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
        assert _max_foreground_concurrency(runtime, provider_type="kimi") == 4  # 5 * 0.8 = 4

    def test_key_pool_single_key_fallback_to_one_for_kimi(self, runtime):
        runtime.key_pool = APIKeyPool(["k1"])
        assert (
            _max_foreground_concurrency(runtime, provider_type="kimi") == 1
        )  # 1 * 0.8 -> max(1, 0) = 1

    def test_key_pool_ignored_for_non_kimi(self, runtime):
        runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
        runtime.config.background.max_running_tasks = 10
        # Non-kimi provider should use max_running_tasks, not key pool
        assert (
            _max_foreground_concurrency(runtime, provider_type="openai_legacy") == 8
        )  # 10 * 0.8 = 8

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

    def test_counts_only_matching_provider_when_given(self, runtime):
        """Kimi cap should not be consumed by unrelated-provider subagents."""
        runtime.config.providers = {
            "kimi_p": LLMProvider(
                type="kimi", base_url="https://kimi.example/v1", api_key=SecretStr("test")
            ),
            "oa_p": LLMProvider(
                type="openai_legacy", base_url="https://oa.example/v1", api_key=SecretStr("test")
            ),
        }
        runtime.config.models = {
            "kimi-k1": LLMModel(provider="kimi_p", model="k1", max_context_size=128_000),
            "gpt-4": LLMModel(provider="oa_p", model="gpt-4", max_context_size=128_000),
        }
        store = runtime.subagent_store
        assert store is not None

        # Kimi instance running
        store.create_instance(
            agent_id="k1",
            description="running kimi",
            launch_spec=AgentLaunchSpec(
                agent_id="k1",
                subagent_type="coder",
                model_override=None,
                effective_model="kimi-k1",
            ),
        )
        store.update_instance("k1", status="running_foreground")

        # OpenAI instance running
        store.create_instance(
            agent_id="o1",
            description="running openai",
            launch_spec=AgentLaunchSpec(
                agent_id="o1",
                subagent_type="coder",
                model_override=None,
                effective_model="gpt-4",
            ),
        )
        store.update_instance("o1", status="running_foreground")

        # Idle instance
        store.create_instance(
            agent_id="i1",
            description="idle",
            launch_spec=AgentLaunchSpec(
                agent_id="i1",
                subagent_type="coder",
                model_override=None,
                effective_model="kimi-k1",
            ),
        )

        # No filter -> count all running
        assert _count_running_foreground(runtime) == 2
        # Filter by kimi -> count only kimi
        assert _count_running_foreground(runtime, provider_type="kimi") == 1
        # Filter by openai -> count only openai
        assert _count_running_foreground(runtime, provider_type="openai_legacy") == 1
        # Filter by nonexistent -> count 0
        assert _count_running_foreground(runtime, provider_type="anthropic") == 0


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


async def test_timeout_cleans_running_foreground_status(agent_tool, runtime, monkeypatch):
    """When wait_for times out before runner.run enters its try block, the instance
    must not be left as 'running_foreground' consuming the concurrency cap."""
    import asyncio

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=Path("/tmp/coder.yaml"),
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    runtime.config.background.max_running_tasks = 10
    runtime.key_pool = None

    # Simulate wait_for timing out immediately.  The inner runner.run coroutine
    # never starts, so its except asyncio.CancelledError block never runs,
    # leaving the instance stuck in "running_foreground" unless the outer
    # TimeoutError handler cleans it up.
    async def fake_wait_for(coro, timeout):
        # Close the coroutine to avoid "was never awaited" warnings.
        coro.close()
        raise TimeoutError() from asyncio.CancelledError()

    monkeypatch.setattr(asyncio, "wait_for", fake_wait_for)

    params = agent_tool.params(description="task", prompt="do something")
    result = await agent_tool(params)

    assert result.is_error
    assert "timed out" in result.brief.lower()

    # Find the newly-created instance and verify it was cleaned up
    store = runtime.subagent_store
    assert store is not None
    instances = store.list_instances()
    assert len(instances) == 1
    assert instances[0].status == "killed"


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


async def test_agent_tool_uses_default_model_for_kimi_cap(agent_tool, runtime, monkeypatch):
    """When a built-in type defaults to a Kimi model, the kimi key-pool cap applies."""
    from kosong.tooling import ToolOk

    runtime.config.providers = {
        "kimi_p": LLMProvider(
            type="kimi", base_url="https://kimi.example/v1", api_key=SecretStr("test")
        ),
    }
    runtime.config.models = {
        "kimi-k1": LLMModel(provider="kimi_p", model="k1", max_context_size=128_000),
    }
    runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
    # Cap = 5 * 0.8 = 4

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=Path("/tmp/coder.yaml"),
            default_model="kimi-k1",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    # Pre-fill 4 running kimi subagents (at the cap)
    store = runtime.subagent_store
    for i in range(4):
        store.create_instance(
            agent_id=f"k{i}",
            description="running",
            launch_spec=AgentLaunchSpec(
                agent_id=f"k{i}",
                subagent_type="coder",
                model_override=None,
                effective_model="kimi-k1",
            ),
        )
        store.update_instance(f"k{i}", status="running_foreground")

    # Patch runner so the 5th call doesn't actually run
    async def fake_run(self, req, prepared=None):
        return ToolOk(output="done")

    monkeypatch.setattr("kimi_cli.subagents.runner.ForegroundSubagentRunner.run", fake_run)

    params = agent_tool.params(description="task", prompt="do something")
    result = await agent_tool(params)

    assert result.is_error
    assert "concurrency limit reached" in result.brief.lower()
    assert "4/4" in result.message


async def test_agent_tool_non_kimi_default_model_ignores_kimi_cap(agent_tool, runtime, monkeypatch):
    """When the default model is non-kimi, the general max_running_tasks cap is used."""
    from kosong.tooling import ToolOk

    runtime.config.providers = {
        "oa_p": LLMProvider(
            type="openai_legacy", base_url="https://oa.example/v1", api_key=SecretStr("test")
        ),
    }
    runtime.config.models = {
        "gpt-4": LLMModel(provider="oa_p", model="gpt-4", max_context_size=128_000),
    }
    runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
    runtime.config.background.max_running_tasks = (
        2  # cap = 2 * 0.8 = 1 (rounded down? no, max(1, 1) = 1)
    )

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=Path("/tmp/coder.yaml"),
            default_model="gpt-4",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    # Pre-fill 1 running openai subagent (at the general cap)
    store = runtime.subagent_store
    store.create_instance(
        agent_id="o1",
        description="running",
        launch_spec=AgentLaunchSpec(
            agent_id="o1",
            subagent_type="coder",
            model_override=None,
            effective_model="gpt-4",
        ),
    )
    store.update_instance("o1", status="running_foreground")

    async def fake_run(self, req, prepared=None):
        return ToolOk(output="done")

    monkeypatch.setattr("kimi_cli.subagents.runner.ForegroundSubagentRunner.run", fake_run)

    params = agent_tool.params(description="task", prompt="do something")
    result = await agent_tool(params)

    assert result.is_error
    assert "concurrency limit reached" in result.brief.lower()
    assert "1/1" in result.message


async def test_agent_tool_resume_respects_model_override_for_provider_cap(
    agent_tool, runtime, monkeypatch
):
    """When resuming an agent with an explicit model override, the concurrency
    check must classify the pending run using the override model's provider,
    not the stored launch spec's old provider."""
    from kosong.tooling import ToolOk

    runtime.config.providers = {
        "kimi_p": LLMProvider(
            type="kimi", base_url="https://kimi.example/v1", api_key=SecretStr("test")
        ),
        "oa_p": LLMProvider(
            type="openai_legacy", base_url="https://oa.example/v1", api_key=SecretStr("test")
        ),
    }
    runtime.config.models = {
        "kimi-k1": LLMModel(provider="kimi_p", model="k1", max_context_size=128_000),
        "gpt-4": LLMModel(provider="oa_p", model="gpt-4", max_context_size=128_000),
    }
    runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
    runtime.config.background.max_running_tasks = 2
    # Kimi cap = 5 * 0.8 = 4; non-kimi cap = 2 * 0.8 = 1

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=Path("/tmp/coder.yaml"),
            default_model="kimi-k1",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    store = runtime.subagent_store
    # Create a stored instance whose launch spec used a Kimi model
    store.create_instance(
        agent_id="resume-me",
        description="old task",
        launch_spec=AgentLaunchSpec(
            agent_id="resume-me",
            subagent_type="coder",
            model_override=None,
            effective_model="kimi-k1",
        ),
    )
    store.update_instance("resume-me", status="idle")

    # Pre-fill 4 running kimi subagents (at the kimi cap)
    for i in range(4):
        store.create_instance(
            agent_id=f"k{i}",
            description="running",
            launch_spec=AgentLaunchSpec(
                agent_id=f"k{i}",
                subagent_type="coder",
                model_override=None,
                effective_model="kimi-k1",
            ),
        )
        store.update_instance(f"k{i}", status="running_foreground")

    async def fake_run(self, req, prepared=None):
        return ToolOk(output="done")

    monkeypatch.setattr("kimi_cli.subagents.runner.ForegroundSubagentRunner.run", fake_run)

    # Resume with an explicit OpenAI model override — should bypass the kimi cap
    params = agent_tool.params(
        description="resume task",
        prompt="continue",
        resume="resume-me",
        model="gpt-4",
    )
    result = await agent_tool(params)

    assert not result.is_error


async def test_agent_tool_resume_override_counts_under_executing_provider(
    agent_tool, runtime, monkeypatch
):
    """When resuming an agent with a Kimi model override, the running instance
    must count against the Kimi key-pool cap, not its original provider."""
    from kosong.tooling import ToolOk

    runtime.config.providers = {
        "kimi_p": LLMProvider(
            type="kimi", base_url="https://kimi.example/v1", api_key=SecretStr("test")
        ),
        "oa_p": LLMProvider(
            type="openai_legacy", base_url="https://oa.example/v1", api_key=SecretStr("test")
        ),
    }
    runtime.config.models = {
        "kimi-k1": LLMModel(provider="kimi_p", model="k1", max_context_size=128_000),
        "gpt-4": LLMModel(provider="oa_p", model="gpt-4", max_context_size=128_000),
    }
    runtime.key_pool = APIKeyPool(["k1", "k2", "k3", "k4", "k5"])
    # Kimi cap = 5 * 0.8 = 4

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=Path("/tmp/coder.yaml"),
            default_model="kimi-k1",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    store = runtime.subagent_store
    # Create a stored instance whose launch spec used an OpenAI model
    store.create_instance(
        agent_id="resume-me",
        description="old task",
        launch_spec=AgentLaunchSpec(
            agent_id="resume-me",
            subagent_type="coder",
            model_override=None,
            effective_model="gpt-4",
        ),
    )
    store.update_instance("resume-me", status="idle")

    # Pre-fill 4 running kimi subagents (at the kimi cap)
    for i in range(4):
        store.create_instance(
            agent_id=f"k{i}",
            description="running",
            launch_spec=AgentLaunchSpec(
                agent_id=f"k{i}",
                subagent_type="coder",
                model_override=None,
                effective_model="kimi-k1",
            ),
        )
        store.update_instance(f"k{i}", status="running_foreground")

    async def fake_run(self, req, prepared=None):
        return ToolOk(output="done")

    monkeypatch.setattr("kimi_cli.subagents.runner.ForegroundSubagentRunner.run", fake_run)

    # Resume with an explicit Kimi model override — should count against kimi cap
    params = agent_tool.params(
        description="resume task",
        prompt="continue",
        resume="resume-me",
        model="kimi-k1",
    )
    result = await agent_tool(params)

    assert result.is_error
    assert "concurrency limit reached" in result.brief.lower()
    assert "4/4" in result.message

    # Verify the persisted launch_spec was updated to reflect the override
    record = store.get_instance("resume-me")
    assert record is not None
    assert record.launch_spec.effective_model == "kimi-k1"
    assert record.launch_spec.model_override == "kimi-k1"
