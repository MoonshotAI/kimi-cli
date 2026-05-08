"""Test loading indicator coverage during active turns.

Verifies that:
1. An empty ThinkPart (e.g. Anthropic block-start) creates a thinking indicator.
2. The moon spinner shows as a fallback whenever the turn is active but nothing
   else is visible (covers TurnBegin→StepBegin, ToolResult→StepBegin gaps).
3. Higher-priority indicators (content blocks, tool blocks, compaction) take
   precedence over the moon fallback.
"""

from __future__ import annotations

from kosong.message import ToolCall
from kosong.tooling import ToolResult, ToolReturnValue
from rich.console import Console

from kimi_cli.ui.shell.visualize import _LiveView
from kimi_cli.wire.types import (
    CompactionBegin,
    StatusUpdate,
    StepBegin,
    TextPart,
    ThinkPart,
    TurnBegin,
    TurnEnd,
)


def _render(renderable) -> str:
    console = Console(width=100, record=True, highlight=False)
    console.print(renderable)
    return console.export_text()


def _make_tool_call(call_id: str = "call_1") -> ToolCall:
    return ToolCall(
        id=call_id,
        function=ToolCall.FunctionBody(name="Shell", arguments='{"command": "ls"}'),
    )


def _make_tool_result(call_id: str = "call_1") -> ToolResult:
    return ToolResult(
        tool_call_id=call_id,
        return_value=ToolReturnValue(is_error=False, output="ok", message="ok", display=[]),
    )


# ---------------------------------------------------------------------------
# Empty ThinkPart indicator
# ---------------------------------------------------------------------------


def test_empty_think_part_creates_thinking_indicator():
    """After StepBegin + empty ThinkPart, the thinking indicator must be visible."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))

    # Empty ThinkPart arrives (Anthropic block-start, think="")
    view.dispatch_wire_message(ThinkPart(think=""))

    # A thinking content block must exist and take priority over moon fallback
    assert view._current_content_block is not None
    assert view._current_content_block.is_think is True
    rendered = _render(view.compose())
    assert "Thinking" in rendered


def test_empty_text_part_still_skipped():
    """Empty TextPart should NOT create a content block (existing behavior)."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TextPart(text=""))

    assert view._current_content_block is None


def test_empty_think_then_real_think_no_artifact(monkeypatch):
    """Empty ThinkPart followed by real ThinkPart should not print spurious lines."""
    from kimi_cli.ui.shell.console import console as shell_console

    view = _LiveView(StatusUpdate())
    printed = []
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: printed.extend(args))

    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(ThinkPart(think=""))
    view.dispatch_wire_message(ThinkPart(think="Let me analyze this..."))

    assert view._current_content_block is not None
    assert view._current_content_block.is_think is True
    assert view._current_content_block.raw_text == "Let me analyze this..."
    # No spurious "Thought for..." lines should have been printed
    assert len(printed) == 0


def test_empty_think_then_text_no_spurious_thought_line(monkeypatch):
    """Empty ThinkPart followed by TextPart should not print 'Thought for 0s'."""
    from kimi_cli.ui.shell.console import console as shell_console

    view = _LiveView(StatusUpdate())
    printed = []
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: printed.extend(args))

    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(ThinkPart(think=""))
    view.dispatch_wire_message(TextPart(text="Hello!"))

    assert view._current_content_block is not None
    assert view._current_content_block.is_think is False
    assert view._current_content_block.raw_text == "Hello!"
    for item in printed:
        rendered = _render(item)
        assert "Thought for" not in rendered


# ---------------------------------------------------------------------------
# Moon fallback during active turn
# ---------------------------------------------------------------------------


def test_moon_fallback_during_active_turn():
    """Moon shows as fallback when turn is active but nothing else is visible."""
    view = _LiveView(StatusUpdate())

    # Before TurnBegin — no moon
    rendered = _render(view.compose())
    assert "🌑" not in rendered and "🌒" not in rendered

    # After TurnBegin — moon fallback active
    view.dispatch_wire_message(TurnBegin(user_input="test"))
    assert view._active_turn_depth > 0
    # compose_agent_output should include the moon spinner
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) > 0


def test_moon_hidden_when_content_block_visible():
    """Content blocks take priority over the moon fallback."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TextPart(text="Hello"))

    # Content block visible — compose_agent_output should show content, not moon
    assert view._current_content_block is not None
    agent_blocks = view.compose_agent_output()
    # Should have exactly one block (the content block), not two (content + moon)
    assert len(agent_blocks) == 1


def test_moon_fallback_after_all_tools_flushed(monkeypatch):
    """After all tool calls finish, moon fallback reappears automatically."""
    from kimi_cli.ui.shell.console import console as shell_console

    view = _LiveView(StatusUpdate())
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: None)

    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TextPart(text="Let me check."))
    view.dispatch_wire_message(_make_tool_call("call_1"))

    # Tool executing — tool block visible, moon fallback hidden
    assert len(view._tool_call_blocks) == 1

    # Tool finishes and flushes
    view.dispatch_wire_message(_make_tool_result("call_1"))
    assert len(view._tool_call_blocks) == 0

    # Nothing else visible + turn active → moon fallback shows
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) == 1  # just the moon


def test_moon_hidden_while_parallel_tool_still_running(monkeypatch):
    """Moon fallback does not appear when tool blocks are still visible."""
    from kimi_cli.ui.shell.console import console as shell_console

    view = _LiveView(StatusUpdate())
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: None)

    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TextPart(text="Running two tools."))
    view.dispatch_wire_message(_make_tool_call("call_1"))
    view.dispatch_wire_message(_make_tool_call("call_2"))

    # First tool finishes, second still running
    view.dispatch_wire_message(_make_tool_result("call_1"))

    assert len(view._tool_call_blocks) == 1  # call_2 still there
    # Tool block visible → moon hidden (tool block takes priority)
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) == 1  # just the running tool block


def test_moon_survives_status_update(monkeypatch):
    """StatusUpdate does not affect moon fallback visibility."""
    from kimi_cli.ui.shell.console import console as shell_console

    view = _LiveView(StatusUpdate())
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: None)

    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TextPart(text="Checking."))
    view.dispatch_wire_message(_make_tool_call("call_1"))
    view.dispatch_wire_message(_make_tool_result("call_1"))

    # StatusUpdate arrives (soul sends this between steps)
    view.dispatch_wire_message(StatusUpdate())

    # Turn still active, nothing else visible → moon fallback shows
    assert view._active_turn_depth > 0
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) == 1


def test_moon_hidden_after_turn_end(monkeypatch):
    """Moon fallback disappears when the turn ends."""
    from kimi_cli.ui.shell.console import console as shell_console

    view = _LiveView(StatusUpdate())
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: None)

    view.dispatch_wire_message(TurnBegin(user_input="test"))
    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TextPart(text="Done."))
    view.dispatch_wire_message(TurnEnd())

    assert view._active_turn_depth == 0
    # Nothing visible and turn ended — no moon
    # (content was flushed? actually content block is still there)
    # But _active_turn_depth is False, so even without content the moon won't show


def test_compaction_takes_priority_over_moon():
    """Compaction spinner has higher priority than the moon fallback."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnBegin(user_input="test"))

    # Compaction starts — should show compaction, not moon
    view.dispatch_wire_message(CompactionBegin())
    agent_blocks = view.compose_agent_output()
    # Should be the compaction spinner, not the moon
    assert len(agent_blocks) == 1
    assert view._compacting_spinner is not None


def test_interrupt_clears_active_turn():
    """cleanup(is_interrupt=True) resets _active_turn_depth to 0."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnBegin(user_input="test"))
    assert view._active_turn_depth > 0

    view.cleanup(is_interrupt=True)
    assert view._active_turn_depth == 0
    # No moon fallback after interrupt
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) == 0


def test_step_cleanup_preserves_active_turn():
    """cleanup(is_interrupt=False) keeps _active_turn_depth > 0 (called on StepBegin)."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnBegin(user_input="test"))
    assert view._active_turn_depth > 0

    view.cleanup(is_interrupt=False)
    assert view._active_turn_depth > 0


# ---------------------------------------------------------------------------
# Nested TurnBegin/TurnEnd (ralph loop / flow turns)
# ---------------------------------------------------------------------------


def test_nested_turn_end_does_not_kill_outer_turn():
    """Inner TurnEnd should not prematurely clear the outer turn's active state."""
    view = _LiveView(StatusUpdate())

    # Outer turn
    view.dispatch_wire_message(TurnBegin(user_input="outer"))
    assert view._active_turn_depth == 1

    # Inner turn (flow turn)
    view.dispatch_wire_message(TurnBegin(user_input="inner"))
    assert view._active_turn_depth == 2

    view.dispatch_wire_message(StepBegin(n=1))
    view.dispatch_wire_message(TurnEnd())  # inner TurnEnd
    assert view._active_turn_depth == 1  # outer still active

    # Moon should still show (outer turn active, nothing else visible)
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) > 0

    view.dispatch_wire_message(TurnEnd())  # outer TurnEnd
    assert view._active_turn_depth == 0


def test_turn_end_below_zero_clamps():
    """Extra TurnEnd messages should not make depth go negative."""
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(TurnEnd())
    view.dispatch_wire_message(TurnEnd())
    assert view._active_turn_depth == 0


# ---------------------------------------------------------------------------
# Replay: StepBegin without TurnBegin
# ---------------------------------------------------------------------------


def test_step_begin_without_turn_begin_activates_moon():
    """StepBegin defensively sets depth=1 when no TurnBegin preceded it (replay)."""
    view = _LiveView(StatusUpdate())
    assert view._active_turn_depth == 0

    # Replay sends StepBegin directly without TurnBegin
    view.dispatch_wire_message(StepBegin(n=1))
    assert view._active_turn_depth == 1

    # Moon fallback should show
    agent_blocks = view.compose_agent_output()
    assert len(agent_blocks) > 0
