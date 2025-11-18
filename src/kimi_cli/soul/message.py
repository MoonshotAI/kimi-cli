from __future__ import annotations

from collections.abc import Sequence

from kosong.message import ContentPart, ImageURLPart, Message, TextPart, ThinkPart
from kosong.tooling import ToolError, ToolOk, ToolResult
from kosong.tooling.error import ToolRuntimeError

from kimi_cli.llm import ModelCapability


def system(message: str) -> ContentPart:
    return TextPart(text=f"<system>{message}</system>")


def tool_result_to_message(tool_result: ToolResult) -> Message:
    """Convert a tool result to a message."""
    if isinstance(tool_result.result, ToolError):
        assert tool_result.result.message, "ToolError should have a message"
        message = tool_result.result.message
        if isinstance(tool_result.result, ToolRuntimeError):
            message += "\nThis is an unexpected error and the tool is probably not working."
        content: list[ContentPart] = [system(f"ERROR: {message}")]
        if tool_result.result.output:
            content.extend(_output_to_content_parts(tool_result.result.output))
    else:
        content = tool_ok_to_message_content(tool_result.result)

    return Message(
        role="tool",
        content=content,
        tool_call_id=tool_result.tool_call_id,
    )


def tool_ok_to_message_content(result: ToolOk) -> list[ContentPart]:
    """Convert a tool return value to a list of message content parts."""
    content: list[ContentPart] = []
    if result.message:
        content.append(system(result.message))
    content.extend(_output_to_content_parts(result.output))
    if not content:
        content.append(system("Tool output is empty."))
    return content


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
