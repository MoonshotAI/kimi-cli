"""Tests for EnterPlanMode / ExitPlanMode user-feedback gating behavior."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kimi_cli.soul import _current_wire
from kimi_cli.soul.toolset import current_tool_call
from kimi_cli.tools.plan import ExitPlanMode, PlanOption
from kimi_cli.tools.plan import Params as ExitParams
from kimi_cli.tools.plan.enter import EnterPlanMode
from kimi_cli.tools.plan.enter import Params as EnterParams
from kimi_cli.wire import Wire
from kimi_cli.wire.types import PlanDisplay, QuestionRequest, ToolCall

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


async def test_enter_plan_noninteractive(enter_tool: EnterPlanMode):
    """Non-interactive mode auto-approves without wire or tool_call."""
    tracker: dict = {}
    enter_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: False,
        can_request_user_feedback=lambda: False,
    )

    wire_token = _current_wire.set(None)
    try:
        result = await enter_tool(EnterParams())
        assert not result.is_error
        assert tracker.get("called")
        assert "auto" in result.message.lower()
    finally:
        _current_wire.reset(wire_token)


async def test_enter_plan_noninteractive_already_in_plan_mode(enter_tool: EnterPlanMode):
    """Guard 'already in plan mode' fires before non-interactive shortcut."""
    tracker: dict = {}
    enter_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: True,  # already in plan mode
        can_request_user_feedback=lambda: False,
    )

    result = await enter_tool(EnterParams())
    assert result.is_error
    assert "Already in plan mode" in result.message
    assert not tracker.get("called")


async def test_enter_plan_feedback_binding_optional(enter_tool: EnterPlanMode):
    """Without a feedback callback, the tool falls through to the normal flow."""
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


async def test_enter_plan_feedback_mode_dynamic_toggle(enter_tool: EnterPlanMode):
    """When user feedback becomes available, the tool falls through to normal flow."""
    feedback_state = {"enabled": False}
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
        can_request_user_feedback=lambda: feedback_state["enabled"],
    )

    # Call 1: feedback unavailable -> auto-approve
    result = await enter_tool(EnterParams())
    assert not result.is_error
    assert tracker.get("called")

    # Reset for second attempt
    plan_mode_state["active"] = False
    tracker.clear()
    feedback_state["enabled"] = True

    # Call 2: feedback available, no wire -> wire error
    wire_token = _current_wire.set(None)
    try:
        result = await enter_tool(EnterParams())
        assert result.is_error
        assert "Wire" in result.message
    finally:
        _current_wire.reset(wire_token)


async def test_enter_plan_requests_confirmation_when_feedback_available(
    enter_tool: EnterPlanMode,
):
    """Interactive mode should emit a QuestionRequest instead of auto-entering."""
    tracker: dict = {}
    wire = Wire()
    wire_token = _current_wire.set(wire)
    tool_call = ToolCall(
        id="tc-enter-plan",
        function=ToolCall.FunctionBody(name="EnterPlanMode", arguments=None),
    )
    tc_token = current_tool_call.set(tool_call)

    enter_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: Path("/tmp/plan.md"),
        plan_mode_checker=lambda: False,
        can_request_user_feedback=lambda: True,
    )

    try:
        tool_task = asyncio.create_task(enter_tool(EnterParams()))
        ui_side = wire.ui_side(merge=False)
        msg = await ui_side.receive()
        assert isinstance(msg, QuestionRequest)
        assert msg.questions[0].question == "Enter plan mode?"

        msg.resolve({"Enter plan mode?": "Yes"})
        result = await tool_task
        assert not result.is_error
        assert tracker.get("called")
        assert "auto" not in result.message.lower()
    finally:
        wire.shutdown()
        current_tool_call.reset(tc_token)
        _current_wire.reset(wire_token)


# ---------------------------------------------------------------------------
# ExitPlanMode
# ---------------------------------------------------------------------------


async def test_exit_plan_noninteractive(exit_tool: ExitPlanMode, tmp_path: Path):
    """Non-interactive mode auto-approves the plan without wire or tool_call."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Test Plan\n- Step 1\n- Step 2")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        can_request_user_feedback=lambda: False,
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


async def test_exit_plan_noninteractive_with_options(exit_tool: ExitPlanMode, tmp_path: Path):
    """Non-interactive auto-approve works even when options are provided."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Plan\n## Option A\n## Option B")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        can_request_user_feedback=lambda: False,
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


async def test_exit_plan_noninteractive_no_plan_file(exit_tool: ExitPlanMode, tmp_path: Path):
    """Non-interactive mode does NOT bypass the 'no plan file' guard."""
    tracker: dict = {}
    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: tmp_path / "nonexistent.md",
        plan_mode_checker=lambda: True,
        can_request_user_feedback=lambda: False,
    )

    result = await exit_tool(ExitParams())
    assert result.is_error
    assert "No plan file" in result.message
    assert not tracker.get("called")


async def test_exit_plan_noninteractive_empty_plan_file(exit_tool: ExitPlanMode, tmp_path: Path):
    """Non-interactive mode does NOT bypass the 'empty plan file' guard."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("")

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        can_request_user_feedback=lambda: False,
    )

    result = await exit_tool(ExitParams())
    assert result.is_error
    assert not tracker.get("called")


async def test_exit_plan_noninteractive_not_in_plan_mode(
    exit_tool: ExitPlanMode, tmp_path: Path
):
    """Guard 'not in plan mode' fires before non-interactive shortcut."""
    tracker: dict = {}
    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: tmp_path / "plan.md",
        plan_mode_checker=lambda: False,
        can_request_user_feedback=lambda: False,
    )

    result = await exit_tool(ExitParams())
    assert result.is_error
    assert "Not in plan mode" in result.message
    assert not tracker.get("called")


async def test_exit_plan_feedback_binding_optional(exit_tool: ExitPlanMode, tmp_path: Path):
    """Without a feedback callback, the tool falls through to the normal flow."""
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


async def test_exit_plan_requests_review_when_feedback_available(
    exit_tool: ExitPlanMode,
    tmp_path: Path,
):
    """Interactive mode should emit PlanDisplay and QuestionRequest before approval."""
    tracker: dict = {}
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Test Plan\n- Step 1\n- Step 2")
    wire = Wire()
    wire_token = _current_wire.set(wire)
    tool_call = ToolCall(
        id="tc-exit-plan",
        function=ToolCall.FunctionBody(name="ExitPlanMode", arguments=None),
    )
    tc_token = current_tool_call.set(tool_call)

    exit_tool.bind(
        toggle_callback=_make_toggle(tracker),
        plan_file_path_getter=lambda: plan_file,
        plan_mode_checker=lambda: True,
        can_request_user_feedback=lambda: True,
    )

    try:
        tool_task = asyncio.create_task(exit_tool(ExitParams()))
        ui_side = wire.ui_side(merge=False)

        plan_msg = await ui_side.receive()
        assert isinstance(plan_msg, PlanDisplay)
        assert plan_msg.content.startswith("# Test Plan")

        question_msg = await ui_side.receive()
        assert isinstance(question_msg, QuestionRequest)
        assert question_msg.questions[0].question == "Approve this plan"

        question_msg.resolve({"Approve this plan": "Approve"})
        result = await tool_task
        assert not result.is_error
        assert tracker.get("called")
        assert "auto" not in result.message.lower()
    finally:
        wire.shutdown()
        current_tool_call.reset(tc_token)
        _current_wire.reset(wire_token)
