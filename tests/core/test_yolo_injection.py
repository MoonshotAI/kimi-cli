"""Tests for yolo and non-interactive injection providers."""

from __future__ import annotations

from unittest.mock import MagicMock

from kimi_cli.soul.dynamic_injections.yolo_mode import (
    _NON_INTERACTIVE_INJECTION_TYPE,
    _NON_INTERACTIVE_PROMPT,
    _YOLO_INJECTION_TYPE,
    _YOLO_PROMPT,
    NonInteractiveModeInjectionProvider,
    YoloModeInjectionProvider,
)


def _mock_soul(is_yolo: bool, *, can_request_user_feedback: bool = True) -> MagicMock:
    soul = MagicMock()
    soul.is_yolo = is_yolo
    soul.can_request_user_feedback = can_request_user_feedback
    return soul


async def test_injects_when_yolo_enabled():
    """Should return one injection on first call when yolo is active."""
    provider = YoloModeInjectionProvider()
    result = await provider.get_injections([], _mock_soul(is_yolo=True))

    assert len(result) == 1
    assert result[0].type == _YOLO_INJECTION_TYPE
    assert result[0].content == _YOLO_PROMPT
    assert "tool approval prompts" in result[0].content.lower()
    assert "non-interactive mode" not in result[0].content.lower()


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


async def test_noninteractive_injects_when_feedback_unavailable():
    provider = NonInteractiveModeInjectionProvider()
    result = await provider.get_injections(
        [],
        _mock_soul(is_yolo=False, can_request_user_feedback=False),
    )

    assert len(result) == 1
    assert result[0].type == _NON_INTERACTIVE_INJECTION_TYPE
    assert result[0].content == _NON_INTERACTIVE_PROMPT
    assert "AskUserQuestion" in result[0].content


async def test_noninteractive_skips_when_feedback_available():
    provider = NonInteractiveModeInjectionProvider()
    result = await provider.get_injections(
        [],
        _mock_soul(is_yolo=True, can_request_user_feedback=True),
    )
    assert result == []
