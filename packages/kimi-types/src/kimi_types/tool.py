from __future__ import annotations

from pydantic import BaseModel

from kimi_types import BriefDisplayBlock, ContentPart, DisplayBlock, JsonType


class ToolReturnValue(BaseModel):
    """The return type of a callable tool."""

    is_error: bool
    """Whether the tool call resulted in an error."""

    # For model
    output: str | list[ContentPart]
    """The output content returned by the tool."""
    message: str
    """An explanatory message to be given to the model."""

    # For user
    display: list[DisplayBlock]
    """The content blocks to be displayed to the user."""

    # For debugging/testing
    extras: dict[str, JsonType] | None = None

    @property
    def brief(self) -> str:
        """Get the brief display block data, if any."""
        for block in self.display:
            if isinstance(block, BriefDisplayBlock):
                return block.text
        return ""


class ToolResult(BaseModel):
    """The result of a tool call."""

    tool_call_id: str
    """The ID of the tool call."""
    return_value: ToolReturnValue
    """The actual return value of the tool call."""


__all__ = [
    "ToolReturnValue",
    "ToolResult",
]
