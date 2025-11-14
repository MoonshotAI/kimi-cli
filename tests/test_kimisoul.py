"""Tests for KimiSoul-specific behavior."""

from __future__ import annotations

import pytest
from kosong.message import TextPart

from kimi_cli.soul.agent import Agent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import CustomToolset


@pytest.mark.asyncio
async def test_kimisoul_injects_agents_md(runtime, tmp_path):
    """Ensure AGENTS.md content is seeded into an empty context."""

    context = Context(tmp_path / "history.jsonl")
    agent = Agent(name="Test Agent", system_prompt="You are a test agent", toolset=CustomToolset())

    soul = KimiSoul(agent, runtime, context=context)

    await soul._ensure_initial_system_messages()

    assert len(context.history) == 1
    message = context.history[0]
    assert message.role == "assistant"
    assert len(message.content) == 1
    assert isinstance(message.content[0], TextPart)
    text = message.content[0].text
    assert "AGENTS.md" in text
    assert runtime.agents_md in text

    # calling again should be a no-op
    await soul._ensure_initial_system_messages()
    assert len(context.history) == 1
