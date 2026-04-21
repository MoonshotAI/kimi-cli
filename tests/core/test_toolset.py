"""Tests for KimiToolset hide/unhide functionality."""

from __future__ import annotations

import asyncio
import contextlib
import json
import tempfile
from pathlib import Path

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from kosong.tooling.error import ToolNotFoundError as KosongToolNotFoundError
from pydantic import BaseModel

from kimi_cli.hooks.config import HookDef
from kimi_cli.hooks.engine import HookEngine
from kimi_cli.soul import _current_wire
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.wire import Wire
from kimi_cli.wire.types import ToolCall, ToolCallRequest, ToolResult


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


# --- PreToolUse hook updatedInput ---


class UpdatableParams(BaseModel):
    command: str = ""
    extra: str = ""


class UpdatableTool(CallableTool2[UpdatableParams]):
    name: str = "UpdatableTool"
    description: str = "Tool with updatable params"
    params: type[UpdatableParams] = UpdatableParams

    def __init__(self) -> None:
        super().__init__()
        self.captured: dict[str, str] = {}

    async def __call__(self, params: UpdatableParams) -> ToolReturnValue:
        self.captured = {"command": params.command, "extra": params.extra}
        return ToolOk(output="ok")


async def test_pre_tool_use_hook_updates_tool_input():
    """PreToolUse hook returning updatedInput modifies the tool arguments."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook_script = Path(tmpdir) / "update.sh"
        hook_script.write_text(
            '#!/bin/bash\n'
            'echo \'{"updatedInput": {"extra": "injected"}}\'\n'
        )
        hook_script.chmod(0o755)

        ts = KimiToolset()
        tool = UpdatableTool()
        ts.add(tool)

        hooks = [
            HookDef(
                event="PreToolUse",
                matcher="UpdatableTool",
                command=str(hook_script),
                timeout=5,
            )
        ]
        engine = HookEngine(hooks, cwd=tmpdir)
        ts.set_hook_engine(engine)

        tool_call = ToolCall(
            id="tc-1",
            function=ToolCall.FunctionBody(
                name="UpdatableTool",
                arguments=json.dumps({"command": "original"}),
            ),
        )
        result = ts.handle(tool_call)
        assert isinstance(result, asyncio.Task)
        resolved = await result

        assert isinstance(resolved, ToolResult)
        assert resolved.return_value.output == "ok"
        assert tool.captured["command"] == "original"
        assert tool.captured["extra"] == "injected"


async def test_pre_tool_use_hook_updates_nested_updated_input():
    """PreToolUse hook returning hookSpecificOutput.updatedInput (rtk format) works."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook_script = Path(tmpdir) / "update-rtk.sh"
        hook_script.write_text(
            '#!/bin/bash\n'
            'echo \'{"hookSpecificOutput": {"updatedInput": {"extra": "rtk-injected"}}}\'\n'
        )
        hook_script.chmod(0o755)

        ts = KimiToolset()
        tool = UpdatableTool()
        ts.add(tool)

        hooks = [
            HookDef(
                event="PreToolUse",
                matcher="UpdatableTool",
                command=str(hook_script),
                timeout=5,
            )
        ]
        engine = HookEngine(hooks, cwd=tmpdir)
        ts.set_hook_engine(engine)

        tool_call = ToolCall(
            id="tc-2",
            function=ToolCall.FunctionBody(
                name="UpdatableTool",
                arguments=json.dumps({"command": "original"}),
            ),
        )
        result = ts.handle(tool_call)
        assert isinstance(result, asyncio.Task)
        resolved = await result

        assert isinstance(resolved, ToolResult)
        assert tool.captured["extra"] == "rtk-injected"


async def test_pre_tool_use_hook_ignores_non_dict_arguments():
    """PreToolUse updatedInput is ignored when tool arguments are not a dict."""
    from kosong.tooling.error import ToolValidateError

    with tempfile.TemporaryDirectory() as tmpdir:
        hook_script = Path(tmpdir) / "update.sh"
        hook_script.write_text(
            '#!/bin/bash\n'
            'echo \'{"updatedInput": {"extra": "injected"}}\'\n'
        )
        hook_script.chmod(0o755)

        ts = KimiToolset()
        tool = UpdatableTool()
        ts.add(tool)

        hooks = [
            HookDef(
                event="PreToolUse",
                matcher="UpdatableTool",
                command=str(hook_script),
                timeout=5,
            )
        ]
        engine = HookEngine(hooks, cwd=tmpdir)
        ts.set_hook_engine(engine)

        # Pass a JSON array instead of an object
        tool_call = ToolCall(
            id="tc-3",
            function=ToolCall.FunctionBody(
                name="UpdatableTool",
                arguments=json.dumps(["item1", "item2"]),
            ),
        )
        result = ts.handle(tool_call)
        assert isinstance(result, asyncio.Task)
        resolved = await result

        # Hook should not crash; tool fails validation because args are not a dict
        assert isinstance(resolved, ToolResult)
        assert isinstance(resolved.return_value, ToolValidateError)
        assert tool.captured == {}


async def test_pre_tool_use_hook_updates_external_tool_request_arguments():
    """updatedInput should be forwarded to wire external tools, not only local tools."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook_script = Path(tmpdir) / "update.sh"
        hook_script.write_text(
            '#!/bin/bash\n'
            'echo \'{"updatedInput": {"command": "rtk git status"}}\'\n'
        )
        hook_script.chmod(0o755)

        ts = KimiToolset()
        ok, reason = ts.register_external_tool(
            name="ExternalShell",
            description="External shell tool",
            parameters={
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        )
        assert ok, reason

        hooks = [
            HookDef(
                event="PreToolUse",
                matcher="ExternalShell",
                command=str(hook_script),
                timeout=5,
            )
        ]
        engine = HookEngine(hooks, cwd=tmpdir)
        ts.set_hook_engine(engine)

        wire = Wire()
        wire_token = _current_wire.set(wire)
        try:
            tool_call = ToolCall(
                id="tc-4",
                function=ToolCall.FunctionBody(
                    name="ExternalShell",
                    arguments=json.dumps({"command": "git status"}),
                ),
            )
            result = ts.handle(tool_call)
            assert isinstance(result, asyncio.Task)

            ui_side = wire.ui_side(merge=False)
            request = await asyncio.wait_for(ui_side.receive(), timeout=1)
            assert isinstance(request, ToolCallRequest)
            assert json.loads(request.arguments or "{}") == {"command": "rtk git status"}

            request.resolve(ToolOk(output="ok"))
            resolved = await result
        finally:
            _current_wire.reset(wire_token)
            wire.shutdown()

        assert isinstance(resolved, ToolResult)
        assert resolved.return_value.output == "ok"
