"""Tests for YoloModeInjectionProvider."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider
from kimi_cli.soul.dynamic_injections.yolo_mode import (
    _YOLO_INJECTION_TYPE,
    _YOLO_PROMPT,
    YoloModeInjectionProvider,
)
from kimi_cli.soul.kimisoul import KimiSoul


def _mock_soul(is_yolo: bool, is_afk: bool = False, is_subagent: bool = False) -> MagicMock:
    soul = MagicMock()
    soul.is_yolo = is_yolo
    soul.is_afk = is_afk
    soul.is_subagent = is_subagent
    return soul


async def test_injects_when_yolo_enabled():
    """Should return one injection on first call when yolo is active (and not afk)."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=True))

    assert len(result) == 1
    assert result[0].type == _YOLO_INJECTION_TYPE
    assert result[0].content == _YOLO_PROMPT
    # New prompt must clarify the user is still present and AskUserQuestion is usable.
    assert "AskUserQuestion" in result[0].content
    assert "Do NOT call AskUserQuestion" not in result[0].content


async def test_no_injection_when_yolo_disabled():
    """Should return empty list when yolo is not active."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=False))
    assert result == []


async def test_no_injection_when_afk_active():
    """Afk takes over; yolo provider must stay silent so the two prompts don't clash."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=True, is_afk=True))
    assert result == []


async def test_no_injection_in_subagent():
    """Subagent has no AskUserQuestion tool and no real terminal user; yolo prompt
    would falsely claim a human is available. Provider must stay silent."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=True, is_subagent=True))
    assert result == []


async def test_injection_lifecycle():
    """Full lifecycle: off -> on (injects) -> on (no re-inject) -> off -> on (no re-inject)."""
    provider = YoloModeInjectionProvider()

    # yolo off: nothing
    assert await provider.get_injections([], _mock_soul(is_yolo=False)) == []

    # yolo on: injects once
    result = await provider.get_injections([], _mock_soul(is_yolo=True))
    assert len(result) == 1

    # yolo still on: no re-inject
    assert await provider.get_injections([], _mock_soul(is_yolo=True)) == []

    # yolo off then on again: no re-inject
    assert await provider.get_injections([], _mock_soul(is_yolo=False)) == []
    assert await provider.get_injections([], _mock_soul(is_yolo=True)) == []


async def test_reinjects_after_context_compaction():
    """After compaction, the one-shot flag should reset so the reminder re-fires."""
    provider = YoloModeInjectionProvider()

    # Initial injection.
    assert len(await provider.get_injections([], _mock_soul(is_yolo=True))) == 1
    assert await provider.get_injections([], _mock_soul(is_yolo=True)) == []

    # Compaction wipes history; provider should be notified to reset.
    await provider.on_context_compacted()

    # Next step after compaction re-injects while yolo is still on.
    result = await provider.get_injections([], _mock_soul(is_yolo=True))
    assert len(result) == 1
    assert result[0].type == _YOLO_INJECTION_TYPE

    # And remains one-shot afterwards until the next compaction.
    assert await provider.get_injections([], _mock_soul(is_yolo=True)) == []


async def test_on_context_compacted_noop_when_yolo_off():
    """Reset is safe to call even when yolo is off / reminder was never injected."""
    provider = YoloModeInjectionProvider()
    await provider.on_context_compacted()
    # Still no injection when yolo is off.
    assert await provider.get_injections([], _mock_soul(is_yolo=False)) == []


# ---------------------------------------------------------------------------
# KimiSoul._notify_injection_providers_compacted isolation
# ---------------------------------------------------------------------------


class _BoomProvider(DynamicInjectionProvider):
    """Buggy provider that raises from both hooks."""

    async def get_injections(self, history, soul) -> list[DynamicInjection]:  # noqa: ARG002
        raise RuntimeError("boom")

    async def on_context_compacted(self) -> None:
        raise RuntimeError("boom-compact")


async def test_compacted_hook_isolates_provider_failures(runtime: Runtime, tmp_path: Path) -> None:
    """A buggy provider must not abort compaction notification of other providers."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    # Drop the default providers and insert: boom provider followed by yolo provider.
    # If the boom provider's exception weren't swallowed, yolo's hook would never run
    # and _injected would stay True.
    yolo = YoloModeInjectionProvider()
    yolo._injected = True  # simulate state after an initial injection
    soul._injection_providers = [_BoomProvider(), yolo]

    # Should not raise.
    await soul._notify_injection_providers_compacted()

    # Yolo's hook ran despite the earlier provider blowing up.
    assert yolo._injected is False


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
    """compact_context() must await on_context_compacted on every registered provider.

    Regression guard: without this, a future refactor that drops the hook call
    would silently break yolo re-injection after compaction.
    """
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
