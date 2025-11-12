from __future__ import annotations

from collections.abc import Sequence

from kosong.message import ContentPart, Message, TextPart
from kosong.tooling import ToolError, ToolOk, ToolResult
from kosong.tooling.error import ToolRuntimeError


def system(message: str) -> ContentPart:
    return TextPart(text=f"<system>{message}</system>")


def tool_result_to_messages(tool_result: ToolResult) -> list[Message]:
    """Convert a tool result to a list of messages."""
    if isinstance(tool_result.result, ToolError):
        assert tool_result.result.message, "ToolError should have a message"
        message = tool_result.result.message
        if isinstance(tool_result.result, ToolRuntimeError):
            message += "\nThis is an unexpected error and the tool is probably not working."
        content: list[ContentPart] = [system(f"ERROR: {message}")]
        if tool_result.result.output:
            content.extend(_output_to_content_parts(tool_result.result.output))
        return [
            Message(
                role="tool",
                content=content,
                tool_call_id=tool_result.tool_call_id,
            )
        ]

    content = tool_ok_to_message_content(tool_result.result)
    text_parts: list[ContentPart] = []
    non_text_parts: list[ContentPart] = []
    for part in content:
        if isinstance(part, TextPart):
            text_parts.append(part)
        else:
            non_text_parts.append(part)

    if not non_text_parts:
        return [
            Message(
                role="tool",
                content=text_parts,
                tool_call_id=tool_result.tool_call_id,
            )
        ]

    text_parts.append(
        system(
            "Tool output contains non-text parts. Non-text parts are sent as a user message below."
        )
    )
    return [
        Message(
            role="tool",
            content=text_parts,
            tool_call_id=tool_result.tool_call_id,
        ),
        Message(role="user", content=non_text_parts),
    ]


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
