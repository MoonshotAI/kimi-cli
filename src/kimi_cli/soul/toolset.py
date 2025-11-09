from contextvars import ContextVar
from typing import override

from kosong.message import ToolCall
from kosong.tooling import HandleResult
from kosong.tooling.simple import SimpleToolset

current_tool_call = ContextVar[ToolCall | None]("current_tool_call", default=None)


def get_current_tool_call_or_none() -> ToolCall | None:
    """
    Get the current tool call or None.
    Expect to be not None when called from a `__call__` method of a tool.
    """
    return current_tool_call.get()


class CustomToolset(SimpleToolset):
    @override
    def handle(self, tool_call: ToolCall) -> HandleResult:
        token = current_tool_call.set(tool_call)
        try:
            return super().handle(tool_call)
        finally:
            current_tool_call.reset(token)
