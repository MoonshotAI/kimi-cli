"""Tests for AfkModeInjectionProvider."""

from __future__ import annotations

from unittest.mock import MagicMock

from kimi_cli.soul.dynamic_injections.afk_mode import (
    _AFK_INJECTION_TYPE,
    _AFK_PROMPT,
    AfkModeInjectionProvider,
)


def _mock_soul(is_afk: bool, is_yolo: bool = False, is_subagent: bool = False) -> MagicMock:
    soul = MagicMock()
    soul.is_afk = is_afk
    soul.is_yolo = is_yolo
    soul.is_subagent = is_subagent
    return soul


async def test_injects_when_afk_enabled() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=True))
    assert len(result) == 1
    assert result[0].type == _AFK_INJECTION_TYPE
    assert result[0].content == _AFK_PROMPT
    assert "afk" in result[0].content.lower()
    assert "Do NOT call AskUserQuestion" in result[0].content


async def test_no_injection_when_afk_disabled() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=False))
    assert result == []


async def test_injected_once_even_if_afk_stays_on() -> None:
    provider = AfkModeInjectionProvider()
    first = await provider.get_injections([], _mock_soul(is_afk=True))
    second = await provider.get_injections([], _mock_soul(is_afk=True))
    assert len(first) == 1
    assert second == []


async def test_injected_when_both_afk_and_yolo() -> None:
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=True, is_yolo=True))
    assert len(result) == 1
    assert result[0].type == _AFK_INJECTION_TYPE


async def test_no_injection_in_subagent() -> None:
    """Subagent has no AskUserQuestion tool; repeating the 'do not ask user' rule
    wastes tokens for each subagent turn. Provider stays silent at the subagent level."""
    provider = AfkModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_afk=True, is_subagent=True))
    assert result == []
