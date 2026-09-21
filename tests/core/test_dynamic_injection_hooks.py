"""Tests for dynamic-injection provider hook handling."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider
from kimi_cli.soul.kimisoul import KimiSoul


class _BoomProvider(DynamicInjectionProvider):
    """Buggy provider that raises from both hooks."""

    async def get_injections(self, history, soul) -> list[DynamicInjection]:  # noqa: ARG002
        raise RuntimeError("boom")

    async def on_context_compacted(self) -> None:
        raise RuntimeError("boom-compact")


class _RecordingProvider(DynamicInjectionProvider):
    """Stub provider that records whether its hooks were awaited."""

    def __init__(self) -> None:
        self.get_injections_calls: int = 0
        self.on_context_compacted_calls: int = 0

    async def get_injections(self, history, soul) -> list[DynamicInjection]:  # noqa: ARG002
        self.get_injections_calls += 1
        return []

    async def on_context_compacted(self) -> None:
        self.on_context_compacted_calls += 1


async def test_compacted_hook_isolates_provider_failures(runtime: Runtime, tmp_path: Path) -> None:
    """A buggy provider must not abort compaction notification of later providers."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    recorder = _RecordingProvider()
    soul._injection_providers = [_BoomProvider(), recorder]  # pyright: ignore[reportPrivateUsage]

    await soul._notify_injection_providers_compacted()  # pyright: ignore[reportPrivateUsage]

    assert recorder.on_context_compacted_calls == 1


def _make_compactable_soul() -> Any:
    """Minimal KimiSoul bypassing __init__, just enough for compact_context().

    Mirrors the pattern used in tests/telemetry/test_instrumentation.py.
    """
    soul = object.__new__(KimiSoul)

    runtime = MagicMock()
    runtime.llm = MagicMock()
    runtime.session.id = "test-session"
    runtime.role = "non-root"  # skip active-task-snapshot branch
    runtime.background_tasks = MagicMock()
    soul._runtime = runtime

    ctx = MagicMock()
    ctx.token_count = 10_000
    ctx.history = []
    ctx.clear = AsyncMock()
    ctx.write_system_prompt = AsyncMock()
    ctx.append_message = AsyncMock()
    ctx.update_token_count = AsyncMock()
    soul._context = ctx

    soul._hook_engine = MagicMock()
    soul._hook_engine.trigger = AsyncMock()

    soul._compaction = MagicMock()

    soul._agent = MagicMock()
    soul._agent.system_prompt = "sys"

    loop_control = MagicMock()
    loop_control.max_retries_per_step = 1
    soul._loop_control = loop_control

    soul._checkpoint = AsyncMock()

    fake_result = MagicMock()
    fake_result.messages = []
    fake_result.estimated_token_count = 2_000
    soul._run_with_connection_recovery = AsyncMock(return_value=fake_result)

    soul._injection_providers = []
    return soul


async def test_compact_context_notifies_injection_providers() -> None:
    """compact_context() must await on_context_compacted on every registered provider."""
    soul = _make_compactable_soul()
    provider_a = _RecordingProvider()
    provider_b = _RecordingProvider()
    soul.add_injection_provider(provider_a)
    soul.add_injection_provider(provider_b)

    with patch("kimi_cli.soul.kimisoul.wire_send"):
        await soul.compact_context()

    assert provider_a.on_context_compacted_calls == 1
    assert provider_b.on_context_compacted_calls == 1


async def test_compact_context_notifies_surviving_providers_after_failure() -> None:
    """A provider raising in its hook must not prevent later providers from being notified."""
    soul = _make_compactable_soul()
    boom = _BoomProvider()
    recorder = _RecordingProvider()
    soul.add_injection_provider(boom)
    soul.add_injection_provider(recorder)

    with patch("kimi_cli.soul.kimisoul.wire_send"):
        await soul.compact_context()

    assert recorder.on_context_compacted_calls == 1
