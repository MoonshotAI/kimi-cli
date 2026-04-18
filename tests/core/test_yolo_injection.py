"""Tests for YoloModeInjectionProvider."""

from __future__ import annotations

from unittest.mock import MagicMock

from kimi_cli.soul.dynamic_injections.yolo_mode import (
    _YOLO_INJECTION_TYPE,
    _YOLO_PROMPT,
    YoloModeInjectionProvider,
)


def _mock_soul(is_yolo: bool) -> MagicMock:
    soul = MagicMock()
    soul.is_yolo = is_yolo
    return soul


async def test_injects_when_yolo_enabled():
    """Should return one injection on first call when yolo is active."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=True))

    assert len(result) == 1
    assert result[0].type == _YOLO_INJECTION_TYPE
    assert result[0].content == _YOLO_PROMPT
    assert "AskUserQuestion" in result[0].content
    assert "remains available" in result[0].content
    assert "Do NOT call" not in result[0].content
    assert "auto-approved in non-interactive mode" not in result[0].content


async def test_no_injection_when_yolo_disabled():
    """Should return empty list when yolo is not active."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=False))
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
