from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from kosong.message import ToolCall
from kosong.tooling import CallableTool, CallableTool2, HandleResult, Tool, Toolset
from kosong.tooling.simple import SimpleToolset

current_tool_call = ContextVar[ToolCall | None]("current_tool_call", default=None)


def get_current_tool_call_or_none() -> ToolCall | None:
    """
    Get the current tool call or None.
    Expect to be not None when called from a `__call__` method of a tool.
    """
    return current_tool_call.get()


type ToolType = CallableTool | CallableTool2[Any]


class KimiToolset:
    def __init__(self) -> None:
        self._inner = SimpleToolset()

    def add(self, tool: ToolType) -> None:
        self._inner += tool

    @property
    def tools(self) -> list[Tool]:
        return self._inner.tools

    def handle(self, tool_call: ToolCall) -> HandleResult:
        token = current_tool_call.set(tool_call)
        try:
            return self._inner.handle(tool_call)
        finally:
            current_tool_call.reset(token)


if TYPE_CHECKING:

    def type_check(kimi_toolset: KimiToolset):
        _: Toolset = kimi_toolset
