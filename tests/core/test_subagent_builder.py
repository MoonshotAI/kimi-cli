from __future__ import annotations

import platform

import pytest
from pydantic import SecretStr

from kimi_cli.agentspec import DEFAULT_AGENT_FILE
from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm_key_pool import APIKeyPool
from kimi_cli.soul.agent import load_agent
from kimi_cli.subagents.builder import SubagentBuilder
from kimi_cli.subagents.models import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_builds_coder_with_write_tools(runtime):
    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    builder = SubagentBuilder(runtime)
    coder = await builder.build_builtin_instance(
        agent_id="acoder",
        type_def=runtime.labor_market.require_builtin_type("coder"),
        launch_spec=AgentLaunchSpec(
            agent_id="acoder",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    tool_names = [tool.name for tool in coder.toolset.tools]
    assert "Shell" in tool_names
    assert "WriteFile" in tool_names
    assert "StrReplaceFile" in tool_names
    assert "Agent" not in tool_names
    assert "AskUserQuestion" not in tool_names
    assert "SetTodoList" not in tool_names


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_builds_explore_read_only_with_shell(runtime):
    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    builder = SubagentBuilder(runtime)
    explore = await builder.build_builtin_instance(
        agent_id="aexplore",
        type_def=runtime.labor_market.require_builtin_type("explore"),
        launch_spec=AgentLaunchSpec(
            agent_id="aexplore",
            subagent_type="explore",
            model_override=None,
            effective_model=None,
        ),
    )

    tool_names = [tool.name for tool in explore.toolset.tools]
    assert "Shell" in tool_names
    assert "ReadFile" in tool_names
    assert "Grep" in tool_names
    assert "WriteFile" not in tool_names
    assert "StrReplaceFile" not in tool_names
    assert "Agent" not in tool_names


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_builds_plan_without_shell_or_write_tools(runtime):
    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    builder = SubagentBuilder(runtime)
    plan = await builder.build_builtin_instance(
        agent_id="aplan",
        type_def=runtime.labor_market.require_builtin_type("plan"),
        launch_spec=AgentLaunchSpec(
            agent_id="aplan",
            subagent_type="plan",
            model_override=None,
            effective_model=None,
        ),
    )

    tool_names = [tool.name for tool in plan.toolset.tools]
    assert "ReadFile" in tool_names
    assert "Glob" in tool_names
    assert "SearchWeb" in tool_names
    assert "Shell" not in tool_names
    assert "WriteFile" not in tool_names
    assert "StrReplaceFile" not in tool_names
    assert "Agent" not in tool_names


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_model_priority_prefers_override_then_type_default_then_inherit(
    runtime, monkeypatch
):
    captured_aliases: list[str | None] = []

    def fake_clone_llm_with_model_alias(
        llm,
        config,
        model_alias,
        *,
        session_id,
        oauth,
        api_key_override=None,
        key_pool=None,
        extra_headers=None,
    ):
        captured_aliases.append(model_alias)
        return llm

    monkeypatch.setattr(
        "kimi_cli.subagents.builder.clone_llm_with_model_alias",
        fake_clone_llm_with_model_alias,
    )

    builder = SubagentBuilder(runtime)
    type_def = AgentTypeDefinition(
        name="explore",
        description="Fast codebase exploration.",
        agent_file=DEFAULT_AGENT_FILE.parent / "explore.yaml",
        default_model="type-default",
        tool_policy=ToolPolicy(mode="allowlist", tools=()),
    )

    await builder.build_builtin_instance(
        agent_id="aoverride",
        type_def=type_def,
        launch_spec=AgentLaunchSpec(
            agent_id="aoverride",
            subagent_type="explore",
            model_override="tool-override",
            effective_model="type-default",
        ),
    )
    await builder.build_builtin_instance(
        agent_id="atype-default",
        type_def=type_def,
        launch_spec=AgentLaunchSpec(
            agent_id="atype-default",
            subagent_type="explore",
            model_override=None,
            effective_model="type-default",
        ),
    )
    await builder.build_builtin_instance(
        agent_id="ainherit",
        type_def=AgentTypeDefinition(
            name="plan",
            description="Planning agent.",
            agent_file=DEFAULT_AGENT_FILE.parent / "plan.yaml",
            default_model=None,
            tool_policy=ToolPolicy(mode="allowlist", tools=()),
        ),
        launch_spec=AgentLaunchSpec(
            agent_id="ainherit",
            subagent_type="plan",
            model_override=None,
            effective_model=None,
        ),
    )

    assert captured_aliases == ["tool-override", "type-default", None]


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_skips_key_pool_for_non_kimi_provider(runtime, monkeypatch):
    """When the root runtime provider is not 'kimi', key pool keys must not be injected."""
    captured = {}

    def fake_clone_llm_with_model_alias(
        llm,
        config,
        model_alias,
        *,
        session_id,
        oauth,
        api_key_override=None,
        key_pool=None,
        extra_headers=None,
    ):
        captured["api_key_override"] = api_key_override
        captured["key_pool"] = key_pool
        return llm

    monkeypatch.setattr(
        "kimi_cli.subagents.builder.clone_llm_with_model_alias",
        fake_clone_llm_with_model_alias,
    )

    runtime.llm.provider_config = LLMProvider(
        type="openai_legacy",
        base_url="https://api.openai.com/v1",
        api_key=SecretStr("sk-test"),
    )
    runtime.key_pool = APIKeyPool(["k1", "k2"])

    type_def = AgentTypeDefinition(
        name="coder",
        description="Coder.",
        agent_file=DEFAULT_AGENT_FILE,
        default_model=None,
        tool_policy=ToolPolicy(mode="inherit"),
    )

    builder = SubagentBuilder(runtime)
    await builder.build_builtin_instance(
        agent_id="aopenai",
        type_def=type_def,
        launch_spec=AgentLaunchSpec(
            agent_id="aopenai",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    assert captured.get("api_key_override") is None
    assert captured.get("key_pool") is None


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_skips_key_pool_when_effective_model_is_non_kimi(runtime, monkeypatch):
    """When the effective model resolves to a non-kimi provider, key pool keys must not be injected."""
    captured = {}

    def fake_clone_llm_with_model_alias(
        llm,
        config,
        model_alias,
        *,
        session_id,
        oauth,
        api_key_override=None,
        key_pool=None,
        extra_headers=None,
    ):
        captured["api_key_override"] = api_key_override
        captured["key_pool"] = key_pool
        return llm

    monkeypatch.setattr(
        "kimi_cli.subagents.builder.clone_llm_with_model_alias",
        fake_clone_llm_with_model_alias,
    )

    runtime.config.providers["openai"] = LLMProvider(
        type="openai_legacy",
        base_url="https://api.openai.com/v1",
        api_key=SecretStr("sk-test"),
    )
    runtime.config.models["gpt-4o"] = LLMModel(
        provider="openai",
        model="gpt-4o",
        max_context_size=128_000,
    )
    runtime.key_pool = APIKeyPool(["k1", "k2"])

    builder = SubagentBuilder(runtime)
    type_def = AgentTypeDefinition(
        name="coder",
        description="Coder.",
        agent_file=DEFAULT_AGENT_FILE,
        default_model="gpt-4o",
        tool_policy=ToolPolicy(mode="inherit"),
    )
    await builder.build_builtin_instance(
        agent_id="aopenai",
        type_def=type_def,
        launch_spec=AgentLaunchSpec(
            agent_id="aopenai",
            subagent_type="coder",
            model_override=None,
            effective_model="gpt-4o",
        ),
    )

    assert captured.get("api_key_override") is None
    assert captured.get("key_pool") is None


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_uses_key_pool_for_kimi_provider(runtime, monkeypatch):
    """When the provider is 'kimi', key pool keys should be acquired and passed."""
    captured = {}

    def fake_clone_llm_with_model_alias(
        llm,
        config,
        model_alias,
        *,
        session_id,
        oauth,
        api_key_override=None,
        key_pool=None,
        extra_headers=None,
    ):
        captured["api_key_override"] = api_key_override
        captured["key_pool"] = key_pool
        return llm

    monkeypatch.setattr(
        "kimi_cli.subagents.builder.clone_llm_with_model_alias",
        fake_clone_llm_with_model_alias,
    )

    runtime.llm.provider_config = LLMProvider(
        type="kimi",
        base_url="https://api.moonshot.cn/v1",
        api_key=SecretStr("sk-test"),
    )
    runtime.key_pool = APIKeyPool(["k1", "k2"])

    type_def = AgentTypeDefinition(
        name="coder",
        description="Coder.",
        agent_file=DEFAULT_AGENT_FILE,
        default_model=None,
        tool_policy=ToolPolicy(mode="inherit"),
    )

    builder = SubagentBuilder(runtime)
    await builder.build_builtin_instance(
        agent_id="akimi",
        type_def=type_def,
        launch_spec=AgentLaunchSpec(
            agent_id="akimi",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    assert captured.get("api_key_override") == "k1"
    assert captured.get("key_pool") is runtime.key_pool
