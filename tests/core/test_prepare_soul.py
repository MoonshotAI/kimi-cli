"""Unit tests for the shared prepare_soul() function in subagents.core."""

from __future__ import annotations

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.soul.context import Context
from kimi_cli.subagents import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy
from kimi_cli.subagents.builder import SubagentBuilder
from kimi_cli.subagents.core import SubagentRunSpec, prepare_soul


def _register_coder(runtime):
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


def _make_spec(runtime, *, agent_id="atest001", resumed=False, prompt="test prompt"):
    type_def = runtime.labor_market.require_builtin_type("coder")
    return SubagentRunSpec(
        agent_id=agent_id,
        type_def=type_def,
        launch_spec=AgentLaunchSpec(
            agent_id=agent_id,
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
        prompt=prompt,
        resumed=resumed,
    )


def _patch_load_agent(monkeypatch, *, system_prompt="sys"):
    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt=system_prompt,
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)


def _create_instance(runtime, agent_id):
    runtime.subagent_store.create_instance(
        agent_id=agent_id,
        description="test",
        launch_spec=AgentLaunchSpec(
            agent_id=agent_id,
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )


@pytest.mark.asyncio
async def test_prepare_soul_writes_prompt_file(runtime, monkeypatch):
    """prepare_soul writes the prompt to the prompt_path file."""
    _register_coder(runtime)
    _patch_load_agent(monkeypatch)
    _create_instance(runtime, "aprompt1")

    spec = _make_spec(runtime, agent_id="aprompt1", prompt="my prompt text")
    builder = SubagentBuilder(runtime)
    await prepare_soul(spec, runtime, builder, runtime.subagent_store)

    written = runtime.subagent_store.prompt_path("aprompt1").read_text(encoding="utf-8")
    assert written == "my prompt text"


@pytest.mark.asyncio
async def test_prepare_soul_restores_system_prompt_on_resume(runtime, monkeypatch):
    """When context already has a system prompt, prepare_soul uses it
    instead of the agent's default."""
    _register_coder(runtime)
    _patch_load_agent(monkeypatch, system_prompt="new system prompt")
    _create_instance(runtime, "aresume1")

    # Pre-write a system prompt to simulate a previous run
    context = Context(runtime.subagent_store.context_path("aresume1"))
    await context.write_system_prompt("old system prompt")

    spec = _make_spec(runtime, agent_id="aresume1", resumed=True)
    builder = SubagentBuilder(runtime)
    soul, _ = await prepare_soul(spec, runtime, builder, runtime.subagent_store)

    assert soul.agent.system_prompt == "old system prompt"


@pytest.mark.asyncio
async def test_prepare_soul_persists_system_prompt_on_first_run(runtime, monkeypatch):
    """On first run (no existing context), prepare_soul writes the agent's
    system prompt into context.jsonl and returns the correct prompt."""
    _register_coder(runtime)
    _patch_load_agent(monkeypatch, system_prompt="fresh system prompt")
    _create_instance(runtime, "afresh01")

    spec = _make_spec(runtime, agent_id="afresh01", resumed=False, prompt="do the work")
    builder = SubagentBuilder(runtime)
    soul, prompt = await prepare_soul(spec, runtime, builder, runtime.subagent_store)

    assert soul.agent.system_prompt == "fresh system prompt"
    assert prompt == "do the work"

    # Verify it was persisted — a second restore should see it
    ctx2 = Context(runtime.subagent_store.context_path("afresh01"))
    await ctx2.restore()
    assert ctx2.system_prompt == "fresh system prompt"


@pytest.mark.asyncio
async def test_prepare_soul_stage_callback(runtime, monkeypatch):
    """on_stage callback receives agent_built, context_restored, context_ready
    in order. on_stage=None must not raise."""
    _register_coder(runtime)
    _patch_load_agent(monkeypatch)

    # --- with callback ---
    _create_instance(runtime, "astage01")
    stages: list[str] = []
    spec = _make_spec(runtime, agent_id="astage01")
    builder = SubagentBuilder(runtime)
    await prepare_soul(spec, runtime, builder, runtime.subagent_store, on_stage=stages.append)
    assert stages == ["agent_built", "context_restored", "context_ready"]

    # --- without callback (on_stage=None) ---
    _create_instance(runtime, "anone001")
    spec2 = _make_spec(runtime, agent_id="anone001")
    soul, prompt = await prepare_soul(
        spec2, runtime, builder, runtime.subagent_store, on_stage=None
    )
    assert soul is not None
    assert prompt == "test prompt"
