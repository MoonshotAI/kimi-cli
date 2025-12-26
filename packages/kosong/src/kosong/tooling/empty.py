from typing import TYPE_CHECKING

from kosong.message import ToolCall
from kosong.tooling import HandleResult, Tool, ToolResult, Toolset
from kosong.tooling.error import ToolNotFoundError

if TYPE_CHECKING:

    def type_check(empty: "EmptyToolset"):
        _: Toolset = empty


class EmptyToolset:
    """A toolset implementation that always contains no tools."""

    @property
    def tools(self) -> list[Tool]:
        return []

    def handle(self, tool_call: ToolCall) -> HandleResult:
        return ToolResult(
            tool_call_id=tool_call.id,
            return_value=ToolNotFoundError(tool_call.function.name),
        )
