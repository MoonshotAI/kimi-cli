"""
Integration tests for the Agent resume flow.

These tests verify that resuming an agent instance reuses the same
context.jsonl (message history accumulates across turns), preserves the
original subagent_type regardless of requested_type, and correctly rejects
concurrent resume attempts.

Uses monkeypatched fake_run_soul to avoid real LLM calls while still
exercising the full runner → context → store pipeline.
"""

from __future__ import annotations

import json
import re

import pytest
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.subagents import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy
from kimi_cli.wire.types import TextPart


def _extract(output: str, key: str) -> str | None:
    match = re.search(rf"^{re.escape(key)}: (.+)$", output, re.MULTILINE)
    return match.group(1) if match is not None else None


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


def _patch_soul(monkeypatch, *, responses: list[str]) -> list[str]:
    """Patch load_agent and run_soul.

    Each call to run_soul appends the next response from *responses* to the
    soul context as an assistant message and records the user_input it received.
    """
    seen_prompts: list[str] = []
    call_idx = 0

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        nonlocal call_idx
        seen_prompts.append(user_input)
        text = responses[call_idx] if call_idx < len(responses) else "fallback"
        call_idx += 1
        await soul.context.append_message(Message(role="assistant", content=[TextPart(text=text)]))

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)
    return seen_prompts


# ---------------------------------------------------------------------------
# Test 1: Resume accumulates context across turns
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_accumulates_context(agent_tool, runtime, monkeypatch):
    """Two foreground turns on the same instance should share a single
    context.jsonl.  The second turn must see the first turn's messages."""
    _register_coder(runtime)

    # Response long enough to avoid summary continuation (>= 200 chars).
    long_response = "First turn completed. " + ("x" * 200)
    second_response = "Second turn done with full context. " + ("y" * 200)
    _patch_soul(monkeypatch, responses=[long_response, second_response])

    # --- Turn 1 ---
    result1 = await agent_tool(
        agent_tool.params(
            description="turn one",
            prompt="do the first thing",
        )
    )
    assert not result1.is_error
    agent_id = _extract(result1.output, "agent_id")
    assert agent_id is not None

    # Verify context.jsonl has content after turn 1.
    ctx_path = runtime.subagent_store.context_path(agent_id)
    lines_after_turn1 = [
        line for line in ctx_path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    assert len(lines_after_turn1) > 0, "context.jsonl should have records after turn 1"
    # Count assistant messages in turn 1.
    assistant_msgs_t1 = [
        json.loads(line)
        for line in lines_after_turn1
        if line.strip() and json.loads(line).get("role") == "assistant"
    ]
    assert len(assistant_msgs_t1) >= 1, "Turn 1 should have at least 1 assistant message"

    # Instance should be idle (completed foreground).
    record = runtime.subagent_store.require_instance(agent_id)
    assert record.status == "idle"

    # --- Turn 2: resume ---
    result2 = await agent_tool(
        agent_tool.params(
            description="turn two",
            prompt="do the second thing",
            resume=agent_id,
        )
    )
    assert not result2.is_error
    assert _extract(result2.output, "resumed") == "true"
    assert _extract(result2.output, "agent_id") == agent_id

    # Verify context.jsonl grew — it should now have more lines.
    lines_after_turn2 = [
        line for line in ctx_path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    assert len(lines_after_turn2) > len(lines_after_turn1), (
        "context.jsonl should accumulate messages across resume turns"
    )
    # Turn 2 should have added at least a user message + assistant message.
    assistant_msgs_t2 = [
        json.loads(line)
        for line in lines_after_turn2
        if line.strip() and json.loads(line).get("role") == "assistant"
    ]
    assert len(assistant_msgs_t2) >= 2, (
        "After two turns, context should have at least 2 assistant messages"
    )


# ---------------------------------------------------------------------------
# Test 2: Resume preserves agent_id and type across turns
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_preserves_identity(agent_tool, runtime, monkeypatch):
    """Resuming an instance must use the stored subagent_type, not the
    requested_type parameter.  The agent_id must not change."""
    _register_coder(runtime)
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="Explore",
            description="Read-only exploration.",
            agent_file=runtime.subagent_store.root / "explore.yaml",
            tool_policy=ToolPolicy(mode="allowlist", tools=("Glob", "Grep")),
        )
    )

    long = "x" * 250
    _patch_soul(monkeypatch, responses=[long, long])

    # Create initial instance as coder.
    result1 = await agent_tool(
        agent_tool.params(
            description="initial",
            prompt="first",
            subagent_type="coder",
        )
    )
    assert not result1.is_error
    agent_id = _extract(result1.output, "agent_id")
    assert _extract(result1.output, "actual_subagent_type") == "coder"

    # Resume but request Explore — actual type should remain coder.
    result2 = await agent_tool(
        agent_tool.params(
            description="resume as explore",
            prompt="second",
            subagent_type="Explore",
            resume=agent_id,
        )
    )
    assert not result2.is_error
    assert _extract(result2.output, "agent_id") == agent_id
    assert _extract(result2.output, "actual_subagent_type") == "coder"
    assert _extract(result2.output, "requested_subagent_type") == "Explore"


# ---------------------------------------------------------------------------
# Test 3: Resume rejects running instance
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_rejects_running_instance(agent_tool, runtime):
    """Attempting to resume an instance that is still running_foreground
    or running_background should return an error, not deadlock or corrupt."""
    _register_coder(runtime)

    for running_status in ("running_foreground", "running_background"):
        agent_id = f"a{running_status[:4]}"
        runtime.subagent_store.create_instance(
            agent_id=agent_id,
            description="busy",
            launch_spec=AgentLaunchSpec(
                agent_id=agent_id,
                subagent_type="coder",
                model_override=None,
                effective_model=None,
            ),
        )
        runtime.subagent_store.update_instance(agent_id, status=running_status)

        result = await agent_tool(
            agent_tool.params(
                description="try resume",
                prompt="please continue",
                resume=agent_id,
            )
        )
        assert result.is_error, f"resume should fail for status={running_status}"
        assert "cannot be resumed concurrently" in result.message


# ---------------------------------------------------------------------------
# Test 4: Resume of nonexistent instance returns clear error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_nonexistent_instance(agent_tool, runtime):
    """Resuming an agent_id that does not exist should return a clear error."""
    result = await agent_tool(
        agent_tool.params(
            description="ghost resume",
            prompt="hello?",
            resume="anonexistent",
        )
    )
    assert result.is_error
    assert "not found" in result.message.lower()
