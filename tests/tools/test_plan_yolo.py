"""Tests for EnterPlanMode / ExitPlanMode auto-approve policy behavior."""

from __future__ import annotations

from pathlib import Path

import pytest

from kimi_cli.soul import _current_wire
from kimi_cli.tools.plan import ExitPlanMode, PlanOption
from kimi_cli.tools.plan import Params as ExitParams
from kimi_cli.tools.plan.enter import EnterPlanMode
from kimi_cli.tools.plan.enter import Params as EnterParams

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_toggle(tracker: dict):
    """Create an async toggle callback that records invocation."""

    async def toggle() -> bool:
        tracker["called"] = True
        return True

    return toggle


@pytest.fixture
def enter_tool() -> EnterPlanMode:
    return EnterPlanMode()


@pytest.fixture
def exit_tool() -> ExitPlanMode:
    return ExitPlanMode()


# ---------------------------------------------------------------------------
# EnterPlanMode
# ---------------------------------------------------------------------------


async def test_enter_plan_auto_approve_policy_true(enter_tool: EnterPlanMode):
    """Auto-approve policy can short-circuit enter flow without wire or tool_call."""
    tracker: dict = {}
    enter_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: False,
        should_auto_approve=lambda: True,
    )

    wire_token = _current_wire.set(None)
    try:
        result = await enter_tool(EnterParams())
        assert not result.is_error
        assert tracker.get("called")
        assert "auto" in result.message.lower()
    finally:
        _current_wire.reset(wire_token)


async def test_enter_plan_policy_guard_already_in_plan_mode(enter_tool: EnterPlanMode):
    """Guard 'already in plan mode' fires before auto-approve policy check."""
    tracker: dict = {}
    enter_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: True,  # already in plan mode
        should_auto_approve=lambda: True,
    )

    result = await enter_tool(EnterParams())
    assert result.is_error
    assert "Already in plan mode" in result.message
    assert not tracker.get("called")


async def test_enter_plan_policy_callback_none(enter_tool: EnterPlanMode):
    """When approval policy callback is not passed, tool falls through to normal flow."""
    tracker: dict = {}
    enter_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: False,
    )

    wire_token = _current_wire.set(None)
    try:
        result = await enter_tool(EnterParams())
        assert result.is_error
        assert "Wire" in result.message
        assert not tracker.get("called")
    finally:
        _current_wire.reset(wire_token)


async def test_enter_plan_auto_approve_policy_dynamic_toggle(enter_tool: EnterPlanMode):
    """When auto-approve policy toggles off, tool falls through to normal flow."""
    auto_approve_policy = {"enabled": True}
    plan_mode_state = {"active": False}
    tracker: dict = {}

    async def toggle() -> bool:
        tracker["called"] = True
        plan_mode_state["active"] = True
        return True

    enter_tool.bind(
        toggle_callback=toggle,
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: plan_mode_state["active"],
        should_auto_approve=lambda: auto_approve_policy["enabled"],
    )

    # Call 1: policy on -> auto-approve
    result = await enter_tool(EnterParams())
    assert not result.is_error
    assert tracker.get("called")

    # Reset for second attempt
    plan_mode_state["active"] = False
    tracker.clear()
    auto_approve_policy["enabled"] = False

    # Call 2: policy off, no wire -> wire error
    wire_token = _current_wire.set(None)
    try:
        result = await enter_tool(EnterParams())
        assert result.is_error
        assert "Wire" in result.message
    finally:
        _current_wire.reset(wire_token)


# ---------------------------------------------------------------------------
# ExitPlanMode
# ---------------------------------------------------------------------------


async def test_exit_plan_auto_approve_policy_true(exit_tool: ExitPlanMode, tmp_path: Path):
    """Auto-approve policy can approve the plan without wire or tool_call."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Test Plan\n- Step 1\n- Step 2")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        should_auto_approve=lambda: True,
    )

    wire_token = _current_wire.set(None)
    try:
        result = await exit_tool(ExitParams())
        assert not result.is_error
        assert tracker.get("called")
        assert "Test Plan" in result.output
        assert "auto" in result.message.lower()
    finally:
        _current_wire.reset(wire_token)


async def test_exit_plan_auto_approve_policy_with_options(exit_tool: ExitPlanMode, tmp_path: Path):
    """Auto-approve policy also works when options are provided (options are ignored)."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Plan\n## Option A\n## Option B")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        should_auto_approve=lambda: True,
    )

    result = await exit_tool(
        ExitParams(
            options=[
                PlanOption(label="Approach A", description="Fast"),
                PlanOption(label="Approach B", description="Thorough"),
            ]
        )
    )
    assert not result.is_error
    assert tracker.get("called")


async def test_exit_plan_auto_approve_policy_no_plan_file(exit_tool: ExitPlanMode, tmp_path: Path):
    """Auto-approve policy does NOT bypass the 'no plan file' guard."""
    tracker: dict = {}
    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: tmp_path / "nonexistent.md",
        plan_mode_checker=lambda: True,
        should_auto_approve=lambda: True,
    )

    result = await exit_tool(ExitParams())
    assert result.is_error
    assert "No plan file" in result.message
    assert not tracker.get("called")


async def test_exit_plan_auto_approve_policy_empty_plan_file(
    exit_tool: ExitPlanMode,
    tmp_path: Path,
):
    """Auto-approve policy does NOT bypass the 'empty plan file' guard."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        should_auto_approve=lambda: True,
    )

    result = await exit_tool(ExitParams())
    assert result.is_error
    assert not tracker.get("called")


async def test_exit_plan_policy_guard_not_in_plan_mode(exit_tool: ExitPlanMode, tmp_path: Path):
    """Guard 'not in plan mode' fires before auto-approve policy check."""
    tracker: dict = {}
    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: tmp_path / "plan.md",
        plan_mode_checker=lambda: False,
        should_auto_approve=lambda: True,
    )

    result = await exit_tool(ExitParams())
    assert result.is_error
    assert "Not in plan mode" in result.message
    assert not tracker.get("called")


async def test_exit_plan_policy_callback_none(exit_tool: ExitPlanMode, tmp_path: Path):
    """When approval policy callback is not passed, tool falls through to normal flow."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Plan content")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
    )

    wire_token = _current_wire.set(None)
    try:
        result = await exit_tool(ExitParams())
        assert result.is_error
        assert "Wire" in result.message
    finally:
        _current_wire.reset(wire_token)
