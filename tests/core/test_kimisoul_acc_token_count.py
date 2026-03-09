from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from kosong.chat_provider import TokenUsage
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import TextPart


async def test_grow_context_uses_usage_total_when_not_compacted(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = KimiSoul(
        Agent(
            name="Test Agent",
            system_prompt="Test system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=Context(file_backend=tmp_path / "history.jsonl"),
    )
    await soul.context.update_token_count(10_000)

    result = SimpleNamespace(
        message=Message(role="assistant", content=[TextPart(text="assistant output")]),
        usage=TokenUsage(input_other=100_000, output=200),
    )
    await soul._grow_context(result, [], compacted_during_tool_execution=False)

    assert soul.context.token_count == result.usage.total


async def test_grow_context_keeps_compacted_baseline_when_compacted(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = KimiSoul(
        Agent(
            name="Test Agent",
            system_prompt="Test system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=Context(file_backend=tmp_path / "history.jsonl"),
    )
    # Simulate token count after compaction.
    await soul.context.update_token_count(10_000)
    baseline = soul.context.token_count

    result = SimpleNamespace(
        message=Message(role="assistant", content=[TextPart(text="assistant output")]),
        usage=TokenUsage(input_other=100_000, output=200),
    )
    await soul._grow_context(result, [], compacted_during_tool_execution=True)

    assert soul.context.token_count > baseline
    assert soul.context.token_count < result.usage.total
