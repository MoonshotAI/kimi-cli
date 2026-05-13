"""Tests for KimiToolset hide/unhide and deduplication functionality."""

from __future__ import annotations

import asyncio
import contextlib
import json

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from kosong.tooling.error import ToolNotFoundError as KosongToolNotFoundError
from pydantic import BaseModel

from kimi_cli.soul.toolset import KimiToolset
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

    assert ts.end_step() == [("ToolA", args)]


async def test_cross_step_duplicate_appends_reminder():
    """A tool call identical to one in the previous step should execute and append reminder in output."""
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
    assert output.startswith("a")
    assert "You are repeating the exact same tool call" in output
    assert ts.dedup_triggered is True
    assert ts.end_step() == [("ToolA", args)]


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
    assert ts.end_step() == [("ToolA", args)]


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

    ts.begin_step([], step_no=1, turn_id="t1")
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
    ts.begin_step([], step_no=1, turn_id="t1")
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
    ts.begin_step([], step_no=1, turn_id="t1")
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
    assert last_calls == [("ToolA", args)]

    # Simulate back_to_the_future: caller clears last_calls
    last_calls = []

    # Step 2: same call with empty last_calls should execute normally
    ts.begin_step(last_calls, step_no=2, turn_id="t1")
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
