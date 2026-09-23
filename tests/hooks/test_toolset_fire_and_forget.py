"""PostToolUse hooks must go through the engine's tracked fire-and-forget path.

`HookEngine.fire_and_forget_trigger` keeps a strong reference to the hook task
(asyncio only holds tasks in a WeakSet) and logs failures. Firing hooks with a
bare `asyncio.create_task` whose handle is discarded loses both.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from pydantic import BaseModel

from kimi_cli.hooks.engine import HookEngine
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.wire.types import ToolCall


class _Params(BaseModel):
    value: str = ""


class _OkTool(CallableTool2[_Params]):
    name: str = "ToolA"
    description: str = "Tool A"
    params: type[_Params] = _Params

    async def __call__(self, params: _Params) -> ToolReturnValue:
        return ToolOk(output="a")


class _FailingTool(CallableTool2[_Params]):
    name: str = "ToolB"
    description: str = "Tool B"
    params: type[_Params] = _Params

    async def __call__(self, params: _Params) -> ToolReturnValue:
        raise RuntimeError("boom")


class _RecordingHookEngine(HookEngine):
    """Records which events were fired through the tracked helper."""

    def __init__(self) -> None:
        super().__init__()
        self.fire_and_forget_events: list[str] = []

    def fire_and_forget_trigger(self, event, *, matcher_value="", input_data):  # type: ignore[no-untyped-def]
        self.fire_and_forget_events.append(event)
        return super().fire_and_forget_trigger(
            event, matcher_value=matcher_value, input_data=input_data
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool", "event"),
    [(_OkTool(), "PostToolUse"), (_FailingTool(), "PostToolUseFailure")],
)
async def test_post_tool_use_hooks_use_tracked_fire_and_forget(
    tool: CallableTool2[_Params], event: str
) -> None:
    engine = _RecordingHookEngine()
    toolset = KimiToolset()
    toolset.add(tool)
    toolset.set_hook_engine(engine)

    tool_call = ToolCall(
        id="call-1",
        function=ToolCall.FunctionBody(name=tool.name, arguments=json.dumps({"value": "x"})),
    )
    result = toolset.handle(tool_call)
    if isinstance(result, asyncio.Task):
        await result

    assert engine.fire_and_forget_events == [event]
