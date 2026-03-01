"""Tests for KimiToolset hide/unhide functionality."""

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
