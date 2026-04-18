from __future__ import annotations

import platform

import pytest

from kimi_cli.agentspec import DEFAULT_AGENT_FILE
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

    def fake_clone_llm_with_model_alias(llm, config, model_alias, *, session_id, oauth):
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


def test_launch_spec_accepts_work_dir():
    from kaos.path import KaosPath

    spec = AgentLaunchSpec(
        agent_id="awd",
        subagent_type="coder",
        model_override=None,
        effective_model=None,
        work_dir="/tmp/some-worktree",
    )
    assert spec.work_dir == "/tmp/some-worktree"


def test_launch_spec_work_dir_defaults_to_none():
    spec = AgentLaunchSpec(
        agent_id="anwd",
        subagent_type="coder",
        model_override=None,
        effective_model=None,
    )
    assert spec.work_dir is None


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_passes_work_dir_override_to_subagent(runtime, temp_work_dir):
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE
    from kimi_cli.soul.agent import load_agent

    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    override_dir = temp_work_dir  # Reuse fixture dir — it exists on disk
    builder = SubagentBuilder(runtime)
    agent = await builder.build_builtin_instance(
        agent_id="awdbuild",
        type_def=runtime.labor_market.require_builtin_type("coder"),
        launch_spec=AgentLaunchSpec(
            agent_id="awdbuild",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
            work_dir=str(override_dir),
        ),
    )
    # The subagent's runtime should use the overridden work_dir
    assert agent.runtime.builtin_args.KIMI_WORK_DIR == override_dir


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_builder_without_work_dir_uses_root_dir(runtime):
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE
    from kimi_cli.soul.agent import load_agent

    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    builder = SubagentBuilder(runtime)
    agent = await builder.build_builtin_instance(
        agent_id="anowdbuild",
        type_def=runtime.labor_market.require_builtin_type("coder"),
        launch_spec=AgentLaunchSpec(
            agent_id="anowdbuild",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    # No override — should inherit root's work_dir
    assert agent.runtime.builtin_args.KIMI_WORK_DIR == runtime.builtin_args.KIMI_WORK_DIR
