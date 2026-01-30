from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from pathlib import Path

import pytest
from kaos.path import KaosPath
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.skill import Skill
from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
from kimi_cli.soul import _current_wire
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.slash import context as context_cmd
from kimi_cli.wire import Wire
from kimi_cli.wire.types import TextPart


def _make_flow() -> Flow:
    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="Begin", kind="begin"),
        "END": FlowNode(id="END", label="End", kind="end"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="END", label=None)],
        "END": [],
    }
    return Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")


def test_flow_skill_registers_skill_and_flow_commands(runtime: Runtime, tmp_path: Path) -> None:
    flow = _make_flow()
    skill_dir = tmp_path / "flow-skill"
    skill_dir.mkdir()
    flow_skill = Skill(
        name="flow-skill",
        description="Flow skill",
        type="flow",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
        flow=flow,
    )
    runtime.skills = {"flow-skill": flow_skill}

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    command_names = {cmd.name for cmd in soul.available_slash_commands}
    assert "skill:flow-skill" in command_names
    assert "flow:flow-skill" in command_names


@pytest.fixture
def wire():
    """Create a Wire for testing and set it as the current wire."""
    wire = Wire()
    token = _current_wire.set(wire)
    yield wire
    _current_wire.reset(token)


@pytest.mark.asyncio
async def test_context_command(runtime: Runtime, tmp_path: Path, wire: Wire) -> None:
    """Test /context slash command with various scenarios."""

    # Test 1: Empty context
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    ui_side = wire.ui_side(merge=True)
    ret = context_cmd(soul, "")
    if isinstance(ret, Awaitable):
        await ret
    wire.soul_side.flush()
    msg = await asyncio.wait_for(ui_side.receive(), timeout=1.0)
    assert isinstance(msg, TextPart)
    assert "Context is empty" in msg.text

    # Test 2: With messages and LLM available
    await soul.context.append_message(Message(role="user", content="Hello"))
    await soul.context.append_message(Message(role="assistant", content="Hi there"))
    await soul.context.checkpoint(add_user_message=False)
    await soul.context.append_message(Message(role="user", content="How are you?"))

    ui_side = wire.ui_side(merge=True)
    ret = context_cmd(soul, "")
    if isinstance(ret, Awaitable):
        await ret
    wire.soul_side.flush()
    msg = await asyncio.wait_for(ui_side.receive(), timeout=1.0)
    assert isinstance(msg, TextPart)

    output = msg.text
    assert "Context Info:" in output
    assert "Total messages: 3" in output
    assert "Checkpoints: 1" in output
    assert "Token usage:" in output
    assert "Messages by role:" in output
    assert "user: 2" in output
    assert "assistant: 1" in output
    assert "\n\n" not in output, f"Found double newlines in output: {repr(output)}"

    # Test 3: Without LLM (uses "Token count:" instead of "Token usage:")
    runtime_no_llm = Runtime(
        config=runtime.config,
        llm=None,
        builtin_args=runtime.builtin_args,
        denwa_renji=runtime.denwa_renji,
        session=runtime.session,
        approval=runtime.approval,
        labor_market=runtime.labor_market,
        environment=runtime.environment,
        skills=runtime.skills,
        oauth=runtime.oauth,
    )

    agent_no_llm = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime_no_llm,
    )
    soul_no_llm = KimiSoul(
        agent_no_llm, context=Context(file_backend=tmp_path / "history_no_llm.jsonl")
    )
    await soul_no_llm.context.append_message(Message(role="user", content="Hello"))

    ui_side = wire.ui_side(merge=True)
    ret = context_cmd(soul_no_llm, "")
    if isinstance(ret, Awaitable):
        await ret
    wire.soul_side.flush()
    msg = await asyncio.wait_for(ui_side.receive(), timeout=1.0)
    assert isinstance(msg, TextPart)

    output = msg.text
    assert "Context Info:" in output
    assert "Token count:" in output
    assert "Token usage:" not in output
    assert "\n\n" not in output, f"Found double newlines in output: {repr(output)}"
