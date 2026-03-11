"""Tests for AskUserQuestion plan mode dynamic description."""

from __future__ import annotations

from kimi_cli.tools.ask_user import _PLAN_MODE_SUFFIX, AskUserQuestion


class TestAskUserPlanModeDescription:
    def test_includes_suffix_when_active(self) -> None:
        tool = AskUserQuestion()
        tool.bind_plan_mode(lambda: True)
        assert _PLAN_MODE_SUFFIX in tool.base.description

    def test_normal_when_inactive(self) -> None:
        tool = AskUserQuestion()
        tool.bind_plan_mode(lambda: False)
        assert _PLAN_MODE_SUFFIX not in tool.base.description

    def test_updates_on_mode_change(self) -> None:
        state = [False]
        tool = AskUserQuestion()
        tool.bind_plan_mode(lambda: state[0])

        # Initially inactive
        assert _PLAN_MODE_SUFFIX not in tool.base.description

        # Activate
        state[0] = True
        assert _PLAN_MODE_SUFFIX in tool.base.description

        # Deactivate
        state[0] = False
        assert _PLAN_MODE_SUFFIX not in tool.base.description

    def test_default_without_bind(self) -> None:
        tool = AskUserQuestion()
        assert _PLAN_MODE_SUFFIX not in tool.base.description

    def test_cache_prevents_recreation(self) -> None:
        tool = AskUserQuestion()
        tool.bind_plan_mode(lambda: True)

        first = tool.base
        second = tool.base
        assert first is second
