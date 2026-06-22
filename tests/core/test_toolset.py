"""Tests for KimiToolset hide/unhide and deduplication functionality."""

from __future__ import annotations

import asyncio
import contextlib
import json

import pytest
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from kosong.tooling.error import ToolNotFoundError as KosongToolNotFoundError
from pydantic import BaseModel

from kimi_cli.soul.toolset import (
    _REMINDER_TEXT_1,
    _REMINDER_TEXT_3,
    KimiToolset,
    _build_repeat_reminder,
)
from kimi_cli.wire.types import ToolCall, ToolResult


class DummyParams(BaseModel):
    value: str = ""


class DummyToolA(CallableTool2[DummyParams]):
    name: str = "ToolA"
    description: str = "Tool A"
    params: type[DummyParams] = DummyParams

    async def __call__(self, params: DummyParams) -> ToolReturnValue:
        return ToolOk(output="a")


class DummyToolB(CallableTool2[DummyParams]):
    name: str = "ToolB"
    description: str = "Tool B"
    params: type[DummyParams] = DummyParams

    async def __call__(self, params: DummyParams) -> ToolReturnValue:
        return ToolOk(output="b")


def _make_toolset() -> KimiToolset:
    ts = KimiToolset()
    ts.add(DummyToolA())
    ts.add(DummyToolB())
    return ts


def _tool_names(ts: KimiToolset) -> set[str]:
    return {t.name for t in ts.tools}


# --- hide() ---


def test_hide_removes_from_tools_property():
    ts = _make_toolset()
    assert _tool_names(ts) == {"ToolA", "ToolB"}

    ts.hide("ToolA")
    assert _tool_names(ts) == {"ToolB"}


def test_hide_returns_true_for_existing_tool():
    ts = _make_toolset()
    assert ts.hide("ToolA") is True


def test_hide_returns_false_for_nonexistent_tool():
    ts = _make_toolset()
    assert ts.hide("NoSuchTool") is False


def test_hide_is_idempotent():
    ts = _make_toolset()
    ts.hide("ToolA")
    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    # Single unhide restores after multiple hides
    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)


def test_hide_multiple_tools():
    ts = _make_toolset()
    ts.hide("ToolA")
    ts.hide("ToolB")
    assert ts.tools == []


# --- unhide() ---


def test_unhide_restores_tool():
    ts = _make_toolset()
    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)


def test_unhide_nonexistent_is_noop():
    ts = _make_toolset()
    ts.unhide("NoSuchTool")
    assert _tool_names(ts) == {"ToolA", "ToolB"}


def test_unhide_without_prior_hide_is_noop():
    ts = _make_toolset()
    ts.unhide("ToolA")
    assert _tool_names(ts) == {"ToolA", "ToolB"}


# --- find() is unaffected ---


def test_hidden_tool_still_findable_by_name():
    ts = _make_toolset()
    ts.hide("ToolA")
    assert ts.find("ToolA") is not None


def test_hidden_tool_still_findable_by_type():
    ts = _make_toolset()
    ts.hide("ToolA")
    assert ts.find(DummyToolA) is not None


# --- handle() is unaffected ---


async def test_hidden_tool_still_handled():
    """handle() should dispatch to hidden tools instead of returning ToolNotFoundError."""
    ts = _make_toolset()
    ts.hide("ToolA")

    tool_call = ToolCall(
        id="tc-1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=json.dumps({"value": "test"}),
        ),
    )
    result = ts.handle(tool_call)
    # For async tools, handle() returns an asyncio.Task.
    # A ToolNotFoundError would be returned as a sync ToolResult directly.
    if isinstance(result, ToolResult):
        assert not isinstance(result.return_value, KosongToolNotFoundError)
    else:
        assert isinstance(result, asyncio.Task)
        result.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await result


async def test_nonexistent_tool_returns_not_found():
    """handle() should return ToolNotFoundError for tools not in _tool_dict at all."""
    ts = _make_toolset()

    tool_call = ToolCall(
        id="tc-2",
        function=ToolCall.FunctionBody(
            name="NoSuchTool",
            arguments="{}",
        ),
    )
    result = ts.handle(tool_call)
    assert isinstance(result, ToolResult)
    assert isinstance(result.return_value, KosongToolNotFoundError)


# --- hide/unhide cycle ---


def test_hide_unhide_cycle():
    """Multiple hide/unhide cycles should work correctly."""
    ts = _make_toolset()

    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)

    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)


# --- deduplication ---


async def test_same_step_dedup():
    """Duplicate tool calls within the same step should share the original result."""
    ts = _make_toolset()
    ts.begin_step([])

    args = json.dumps({"value": "x"})
    tool_call_1 = ToolCall(
        id="tc-dedup-1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )
    tool_call_2 = ToolCall(
        id="tc-dedup-2",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )

    result_1 = ts.handle(tool_call_1)
    assert isinstance(result_1, asyncio.Task)

    result_2 = ts.handle(tool_call_2)
    assert isinstance(result_2, asyncio.Task)

    # Both should eventually return the same output but with different tool_call_id
    tr_1 = await result_1
    tr_2 = await result_2

    assert tr_1.return_value.output == "a"
    assert tr_2.return_value.output == "a"
    assert tr_1.tool_call_id == "tc-dedup-1"
    assert tr_2.tool_call_id == "tc-dedup-2"

    assert ts.end_step() == [("ToolA", '{"value":"x"}'), ("ToolA", '{"value":"x"}')]


async def test_same_step_dedup_canonicalizes_argument_key_order():
    """Equivalent JSON objects with different key order should share the original result."""
    ts = _make_toolset()
    ts.begin_step([])

    tool_call_1 = ToolCall(
        id="tc-canonical-1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments='{"a": 1, "b": 2}',
        ),
    )
    tool_call_2 = ToolCall(
        id="tc-canonical-2",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments='{"b": 2, "a": 1}',
        ),
    )

    result_1 = ts.handle(tool_call_1)
    result_2 = ts.handle(tool_call_2)
    assert isinstance(result_1, asyncio.Task)
    assert isinstance(result_2, asyncio.Task)

    tr_1 = await result_1
    tr_2 = await result_2

    assert tr_1.return_value.output == "a"
    assert tr_2.return_value.output == "a"
    assert ts.end_step() == [("ToolA", '{"a":1,"b":2}'), ("ToolA", '{"a":1,"b":2}')]


async def test_cross_step_duplicate_does_not_append_reminder_below_three_consecutive():
    """The second consecutive identical call is tracked but not reminded yet."""
    ts = _make_toolset()
    args = json.dumps({"value": "x"})
    ts.begin_step([("ToolA", args)])

    tool_call = ToolCall(
        id="tc-dedup-reminder",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )

    result = ts.handle(tool_call)
    assert isinstance(result, asyncio.Task)
    tr = await result
    output = tr.return_value.output
    assert isinstance(output, str)
    assert output == "a"
    assert ts.dedup_triggered is True
    assert ts.end_step() == [("ToolA", '{"value":"x"}')]


async def test_cross_step_duplicate_appends_reminder_at_three_consecutive():
    """The first reminder is sparse and appears only at the third consecutive call."""
    ts = _make_toolset()
    args = json.dumps({"value": "x"})
    previous_calls: list[tuple[str, str]] = []

    for i in range(2):
        ts.begin_step(previous_calls)
        result = ts.handle(
            ToolCall(
                id=f"tc-repeat-prior-{i}",
                function=ToolCall.FunctionBody(name="ToolA", arguments=args),
            )
        )
        assert isinstance(result, asyncio.Task)
        tr = await result
        assert "system-reminder" not in tr.return_value.output
        previous_calls = ts.end_step()

    ts.begin_step(previous_calls)
    result = ts.handle(
        ToolCall(
            id="tc-repeat-third",
            function=ToolCall.FunctionBody(name="ToolA", arguments=args),
        )
    )
    assert isinstance(result, asyncio.Task)
    tr = await result
    output = tr.return_value.output
    assert isinstance(output, str)
    assert "You are repeating the exact same tool call" in output
    assert "repeated_times" not in output


async def test_cross_step_duplicate_uses_sparse_stronger_reminders():
    """The stronger reminder appears at the fifth repeat and includes canonical args."""
    ts = _make_toolset()
    args = '{"b": 2, "a": 1}'
    previous_calls: list[tuple[str, str]] = []
    last_output = ""

    for i in range(5):
        ts.begin_step(previous_calls)
        result = ts.handle(
            ToolCall(
                id=f"tc-repeat-{i}",
                function=ToolCall.FunctionBody(name="ToolA", arguments=args),
            )
        )
        assert isinstance(result, asyncio.Task)
        tr = await result
        last_output = tr.return_value.output
        previous_calls = ts.end_step()

    assert isinstance(last_output, str)
    assert "You have repeatedly called the same tool" in last_output
    assert "repeated_times: 5" in last_output
    assert "tool: ToolA" in last_output
    assert 'arguments: {"a":1,"b":2}' in last_output


async def test_non_duplicate_allowed():
    """A tool call with different arguments should be allowed even if the tool name matches."""
    ts = _make_toolset()
    ts.begin_step([("ToolA", json.dumps({"value": "x"}))])

    args = json.dumps({"value": "y"})
    tool_call = ToolCall(
        id="tc-ok-1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )

    result = ts.handle(tool_call)
    assert isinstance(result, asyncio.Task)
    tr = await result
    assert tr.return_value.output == "a"
    assert ts.dedup_triggered is False
    assert ts.end_step() == [("ToolA", '{"value":"y"}')]


def test_begin_end_step():
    """begin_step and end_step should correctly manage deduplication state."""
    ts = _make_toolset()

    ts.begin_step([("ToolA", "{}")])
    assert ts._previous_step_calls == [("ToolA", "{}")]
    assert ts._current_step_calls == []
    assert ts._current_step_tasks == {}
    assert ts.dedup_triggered is False

    ts._current_step_calls.append(("ToolB", "{}"))
    assert ts.end_step() == [("ToolB", "{}")]

    # After end_step, internal lists are not cleared by end_step itself;
    # the caller (KimiSoul) is expected to call begin_step again for the next step.
    # But dedup_triggered should still reflect the last step's state.
    assert ts.dedup_triggered is False


async def test_begin_step_resets_cancelled_tasks():
    """begin_step() must clear _current_step_tasks so a retry does not await a cancelled task."""
    ts = _make_toolset()

    ts.begin_step([])
    args = json.dumps({"value": "x"})
    tc1 = ToolCall(
        id="c1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )
    result1 = ts.handle(tc1)
    assert isinstance(result1, asyncio.Task)
    result1.cancel()

    # Simulate retry: begin_step again for the same step
    ts.begin_step([])
    tc2 = ToolCall(
        id="c2",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )
    result2 = ts.handle(tc2)
    assert isinstance(result2, asyncio.Task)
    assert result2 is not result1

    # The new task should complete successfully (not raise CancelledError)
    tr = await result2
    assert tr.return_value.output == "a"


async def test_cross_step_dedup_not_triggered_after_back_to_the_future():
    """When _last_tool_calls is emptied (back_to_the_future), the same call must not be treated as a cross-step duplicate."""
    ts = _make_toolset()

    # Step 1: execute a tool
    args = json.dumps({"value": "x"})
    ts.begin_step([])
    tc1 = ToolCall(
        id="c1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )
    result1 = ts.handle(tc1)
    assert isinstance(result1, asyncio.Task)
    await result1
    last_calls = ts.end_step()
    assert last_calls == [("ToolA", '{"value":"x"}')]

    # Simulate back_to_the_future: caller clears last_calls
    last_calls = []

    # Step 2: same call with empty last_calls should execute normally
    ts.begin_step(last_calls)
    tc2 = ToolCall(
        id="c2",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=args,
        ),
    )
    result2 = ts.handle(tc2)
    assert isinstance(result2, asyncio.Task)
    tr = await result2

    # Should NOT have the cross-step reminder appended
    assert tr.return_value.output == "a"
    assert ts.dedup_triggered is False


async def _run_consecutive(
    ts: KimiToolset,
    count: int,
    *,
    args: str = '{"value":"x"}',
    tool: str = "ToolA",
) -> ToolResult:
    previous_calls: list[tuple[str, str]] = []
    last: ToolResult | None = None
    for i in range(count):
        ts.begin_step(previous_calls)
        result = ts.handle(
            ToolCall(
                id=f"tc-repeat-{i}",
                function=ToolCall.FunctionBody(name=tool, arguments=args),
            )
        )
        assert isinstance(result, asyncio.Task)
        last = await result
        previous_calls = ts.end_step()
    assert last is not None
    return last


def test_build_repeat_reminder_tiers():
    assert _build_repeat_reminder(1, "ToolA", "{}") == ("none", None)
    assert _build_repeat_reminder(2, "ToolA", "{}") == ("none", None)

    action, text = _build_repeat_reminder(3, "ToolA", "{}")
    assert action == "r1"
    assert text == _REMINDER_TEXT_1

    action, text = _build_repeat_reminder(4, "ToolA", "{}")
    assert action == "r1"
    assert text == _REMINDER_TEXT_1

    action, text = _build_repeat_reminder(5, "ToolA", '{"a":1}')
    assert action == "r2"
    assert text is not None
    assert "repeated_times: 5" in text
    assert "tool: ToolA" in text
    assert 'arguments: {"a":1}' in text

    action, text = _build_repeat_reminder(7, "ToolA", "{}")
    assert action == "r2"
    assert text is not None
    assert "repeated_times: 7" in text

    action, text = _build_repeat_reminder(8, "ToolA", "{}")
    assert action == "r3"
    assert text == _REMINDER_TEXT_3

    action, text = _build_repeat_reminder(11, "ToolA", "{}")
    assert action == "r3"
    assert text == _REMINDER_TEXT_3

    action, text = _build_repeat_reminder(12, "ToolA", "{}")
    assert action == "stop"
    assert text == _REMINDER_TEXT_3

    action, text = _build_repeat_reminder(20, "ToolA", "{}")
    assert action == "stop"
    assert text == _REMINDER_TEXT_3


@pytest.mark.parametrize(
    ("streak", "expected_fragment"),
    [
        (3, "You are repeating the exact same tool call"),
        (4, "You are repeating the exact same tool call"),
        (5, "You have repeatedly called the same tool"),
        (6, "You have repeatedly called the same tool"),
        (7, "You have repeatedly called the same tool"),
        (8, "stuck in a dead end"),
        (9, "stuck in a dead end"),
        (10, "stuck in a dead end"),
        (11, "stuck in a dead end"),
        (12, "stuck in a dead end"),
    ],
)
async def test_cross_step_duplicate_injects_reminder_on_every_repeat(
    streak: int, expected_fragment: str
):
    ts = _make_toolset()
    tr = await _run_consecutive(ts, streak)
    output = tr.return_value.output
    assert isinstance(output, str)
    assert "system-reminder" in output
    assert expected_fragment in output


async def test_cross_step_duplicate_no_reminder_below_three():
    for count in (1, 2):
        ts = _make_toolset()
        tr = await _run_consecutive(ts, count)
        output = tr.return_value.output
        assert isinstance(output, str)
        assert "system-reminder" not in output


async def test_cross_step_duplicate_does_not_force_stop_below_twelve():
    ts = _make_toolset()
    await _run_consecutive(ts, 11)
    assert ts.force_stop_turn is False


async def test_cross_step_duplicate_force_stops_turn_at_twelve():
    ts = _make_toolset()
    tr = await _run_consecutive(ts, 12)
    assert ts.force_stop_turn is True
    output = tr.return_value.output
    assert isinstance(output, str)
    assert "stuck in a dead end" in output


async def test_force_stop_does_not_mark_result_as_error():
    ts = _make_toolset()
    tr = await _run_consecutive(ts, 12)
    assert ts.force_stop_turn is True
    assert not isinstance(tr.return_value, ToolError)
    assert isinstance(tr.return_value.output, str)
    assert tr.return_value.output.startswith("a")


async def test_force_stop_resets_each_step():
    ts = _make_toolset()
    await _run_consecutive(ts, 12)
    assert ts.force_stop_turn is True

    ts.begin_step([("ToolA", '{"value":"x"}')])
    assert ts.force_stop_turn is False


async def test_tool_call_repeat_telemetry_matches_kimi_code(
    monkeypatch: pytest.MonkeyPatch,
):
    events: list[tuple[str, dict[str, object]]] = []

    def fake_track(event: str, **props: object) -> None:
        events.append((event, props))

    monkeypatch.setattr("kimi_cli.telemetry.track", fake_track)

    ts = _make_toolset()
    previous_calls: list[tuple[str, str]] = []
    for i in range(5):
        ts.begin_step(previous_calls)
        result = ts.handle(
            ToolCall(
                id=f"tc-{i}",
                function=ToolCall.FunctionBody(name="ToolA", arguments='{"value":"x"}'),
            )
        )
        assert isinstance(result, asyncio.Task)
        await result
        previous_calls = ts.end_step()

    repeat_events = [(e, p) for e, p in events if e == "tool_call_repeat"]
    assert [p["repeat_count"] for _, p in repeat_events] == [2, 3, 4, 5]
    assert [p["action"] for _, p in repeat_events] == ["none", "r1", "r1", "r2"]
    assert all(p["tool_name"] == "ToolA" for _, p in repeat_events)
    assert all(set(p) == {"tool_name", "repeat_count", "action"} for _, p in repeat_events)
