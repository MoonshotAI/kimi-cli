"""Tests for KimiSoul-specific behavior."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from kosong.message import Message, TextPart

from kimi_cli.soul.agent import Agent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset


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


@pytest.mark.asyncio
async def test_compaction_reinjects_agents_md(runtime, tmp_path):
    """Ensure AGENTS.md content is re-added after compaction."""

    context = Context(tmp_path / "history.jsonl")
    agent = Agent(name="Test Agent", system_prompt="You are a test agent", toolset=CustomToolset())
    soul = KimiSoul(agent, runtime, context=context)

    await soul._checkpoint()
    await context.append_message(Message(role="user", content="Hello"))

    summary = Message(role="assistant", content="Summary")
    preserved_assistant = Message(role="assistant", content="Assistant reply")
    preserved_user = Message(role="user", content="Most recent question")

    mock_compaction = SimpleNamespace()
    mock_compaction.compact = AsyncMock(
        return_value=[summary, preserved_assistant, preserved_user]
    )
    soul._compaction = mock_compaction  # type: ignore[assignment]

    await soul.compact_context()

    history = list(context.history)
    assert len(history) == 4
    assert history[0] is summary
    reinjected = history[1]
    assert reinjected.role == "assistant"
    assert isinstance(reinjected.content, list)
    assert isinstance(reinjected.content[0], TextPart)
    assert runtime.agents_md in reinjected.content[0].text
    assert history[2] is preserved_assistant
    assert history[3] is preserved_user
    assert history[-1].role == "user"


@pytest.mark.asyncio
async def test_kimisoul_backfills_agents_md_into_existing_history(runtime, tmp_path):
    """Ensure AGENTS.md is injected when restoring a history without it."""

    context = Context(tmp_path / "history.jsonl")
    await context.append_message(Message(role="user", content="Prior conversation"))
    agent = Agent(name="Test Agent", system_prompt="You are a test agent", toolset=CustomToolset())
    soul = KimiSoul(agent, runtime, context=context)

    await soul._ensure_initial_system_messages()

    assert len(context.history) == 2
    agents_message = context.history[-1]
    assert agents_message.role == "assistant"
    assert isinstance(agents_message.content, list)
    assert isinstance(agents_message.content[0], TextPart)
    assert runtime.agents_md in agents_message.content[0].text

    await soul._ensure_initial_system_messages()
    assert len(context.history) == 2
