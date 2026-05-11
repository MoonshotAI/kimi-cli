"""Tests for AfkModeInjectionProvider."""

from __future__ import annotations

from unittest.mock import MagicMock

from kimi_cli.soul.dynamic_injections.afk_mode import (
    _AFK_INJECTION_TYPE,
    _AFK_PROMPT_ROOT,
    AfkModeInjectionProvider,
)


def _mock_soul(
    is_afk: bool,
    is_afk_flag: bool = True,
    is_yolo: bool = False,
    is_subagent: bool = False,
    has_ask_user: bool = True,
) -> MagicMock:
    soul = MagicMock()
    soul.is_afk = is_afk
    soul.is_afk_flag = is_afk_flag
    soul.is_yolo = is_yolo
    soul.is_subagent = is_subagent
    soul.has_tool.return_value = has_ask_user
    return soul


async def test_injects_when_afk_enabled() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=True))
    assert len(result) == 1
    assert result[0].type == _AFK_INJECTION_TYPE
    assert result[0].content == _AFK_PROMPT_ROOT
    assert "afk" in result[0].content.lower()
    assert "Do NOT call AskUserQuestion" in result[0].content


async def test_runtime_afk_does_not_inject_prompt() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=True, is_afk_flag=False))
    assert result == []


async def test_no_injection_when_afk_disabled() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=False))
    assert result == []


async def test_persistent_afk_injected_once_even_if_afk_stays_on() -> None:
    provider = AfkModeInjectionProvider()
    first = await provider.get_injections([], _mock_soul(is_afk=True))
    second = await provider.get_injections([], _mock_soul(is_afk=True))
    assert len(first) == 1
    assert second == []


async def test_runtime_afk_does_not_rearm_prompt() -> None:
    provider = AfkModeInjectionProvider()
    soul = _mock_soul(is_afk=True, is_afk_flag=False)
    first = await provider.get_injections([], soul)
    second = await provider.get_injections([], soul)
    assert first == []
    assert second == []


async def test_injected_when_both_afk_and_yolo() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=True, is_yolo=True))
    assert len(result) == 1
    assert result[0].type == _AFK_INJECTION_TYPE


async def test_injects_even_when_ask_user_unavailable() -> None:
    """Afk is a global non-interactive mode, independent of tool availability."""
    provider = AfkModeInjectionProvider()
    soul = _mock_soul(is_afk=True, has_ask_user=False)
    result = await provider.get_injections([], soul)
    assert len(result) == 1
    assert result[0].type == _AFK_INJECTION_TYPE
    soul.has_tool.assert_not_called()


async def test_does_not_inject_in_subagent() -> None:
    """Subagents should not receive root afk prompt injections."""
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections(
        [],
        _mock_soul(is_afk=True, is_subagent=True),
    )
    assert result == []


async def test_rearms_after_afk_toggle_cycle() -> None:
    provider = AfkModeInjectionProvider()
    soul = _mock_soul(is_afk=True)

    first = await provider.get_injections([], soul)
    second = await provider.get_injections([], soul)
    assert len(first) == 1
    assert second == []

    await provider.on_afk_changed(False)
    await provider.on_afk_changed(True)

    third = await provider.get_injections([], soul)
    assert len(third) == 1
    assert third[0].type == _AFK_INJECTION_TYPE


async def test_rearms_after_context_compaction() -> None:
    provider = AfkModeInjectionProvider()
    soul = _mock_soul(is_afk=True)

    first = await provider.get_injections([], soul)
    second = await provider.get_injections([], soul)
    assert len(first) == 1
    assert second == []

    await provider.on_context_compacted()

    third = await provider.get_injections([], soul)
    assert len(third) == 1
    assert third[0].type == _AFK_INJECTION_TYPE
