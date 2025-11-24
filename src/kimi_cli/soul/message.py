from __future__ import annotations

from collections.abc import Sequence

from kosong.message import ContentPart, ImageURLPart, Message, TextPart, ThinkPart
from kosong.tooling import ToolError, ToolResult
from kosong.tooling.error import ToolRuntimeError

from kimi_cli.llm import ModelCapability


def system(message: str) -> ContentPart:
    return TextPart(text=f"<system>{message}</system>")


def tool_result_to_message(tool_result: ToolResult) -> Message:
    """Convert a tool result to a message."""
    if isinstance(tool_result.return_value, ToolError):
        assert tool_result.return_value.message, "ToolError should have a message"
        message = tool_result.return_value.message
        if isinstance(tool_result.return_value, ToolRuntimeError):
            message += "\nThis is an unexpected error and the tool is probably not working."
        content: list[ContentPart] = [system(f"ERROR: {message}")]
        if tool_result.return_value.output:
            content.extend(_output_to_content_parts(tool_result.return_value.output))
    else:
        content: list[ContentPart] = []
        if tool_result.return_value.message:
            content.append(system(tool_result.return_value.message))
        if tool_result.return_value.output:
            content.extend(_output_to_content_parts(tool_result.return_value.output))
        if not content:
            content.append(system("Tool output is empty."))

    return Message(
        role="tool",
        content=content,
        tool_call_id=tool_result.tool_call_id,
    )


def _output_to_content_parts(
    output: str | ContentPart | Sequence[ContentPart],
) -> list[ContentPart]:
    content: list[ContentPart] = []
    match output:
        case str(text):
            if text:
                content.append(TextPart(text=text))
        case ContentPart():
            content.append(output)
        case _:
            content.extend(output)
    return content


def check_message(
    message: Message, model_capabilities: set[ModelCapability]
) -> set[ModelCapability]:
    """Check the message content, return the missing model capabilities."""
    if isinstance(message.content, str):
        return set()
    capabilities_needed = set[ModelCapability]()
    for part in message.content:
        if isinstance(part, ImageURLPart):
            capabilities_needed.add("image_in")
        elif isinstance(part, ThinkPart):
            capabilities_needed.add("thinking")
    return capabilities_needed - model_capabilities
