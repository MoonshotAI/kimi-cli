from __future__ import annotations

from collections.abc import Sequence

from kosong.message import Message
from kosong.tooling.error import ToolRuntimeError

from kimi_cli.llm import ModelCapability
from kimi_cli.wire.types import (
    ContentPart,
    ImageURLPart,
    TextPart,
    ThinkPart,
    ToolResult,
    VideoURLPart,
)


def system(message: str) -> ContentPart:
    return TextPart(text=f"<system>{message}</system>")


def system_reminder(message: str) -> TextPart:
    return TextPart(text=f"<system-reminder>\n{message}\n</system-reminder>")


def is_system_reminder_message(message: Message) -> bool:
    """Check whether a message is an internal system-reminder user message."""
    if message.role != "user" or len(message.content) != 1:
        return False
    part = message.content[0]
    return isinstance(part, TextPart) and part.text.strip().startswith("<system-reminder>")


def tool_result_to_message(tool_result: ToolResult) -> Message:
    """Convert a tool result to a message."""
    if tool_result.return_value.is_error:
        assert tool_result.return_value.message, "Error return value should have a message"
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
        elif not any(isinstance(part, TextPart) for part in content):
            # Ensure at least one TextPart exists so the LLM API won't reject
            # the message with "text content is empty" (see #1663).
            content.insert(0, system("Tool returned non-text content."))

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
    capabilities_needed = set[ModelCapability]()
    for part in message.content:
        if isinstance(part, ImageURLPart):
            capabilities_needed.add("image_in")
        elif isinstance(part, VideoURLPart):
            capabilities_needed.add("video_in")
        elif isinstance(part, ThinkPart):
            capabilities_needed.add("thinking")
    return capabilities_needed - model_capabilities


def omit_unsupported_media(
    message: Message, model_capabilities: set[ModelCapability]
) -> tuple[Message, set[ModelCapability]]:
    """Replace unsupported image/video parts with a short text note.

    Used for tool results so a missing ``image_in``/``video_in`` capability does
    not abort the run after the tool has already executed. Returns the (possibly
    rewritten) message and the set of capabilities that were omitted.
    """
    omitted = set[ModelCapability]()
    new_content: list[ContentPart] = []
    for part in message.content:
        if isinstance(part, ImageURLPart) and "image_in" not in model_capabilities:
            omitted.add("image_in")
            new_content.append(
                system(
                    "Image omitted: model has no image_in capability. "
                    'Add capabilities = ["image_in"] to [models.<alias>] in config.toml.'
                )
            )
        elif isinstance(part, VideoURLPart) and "video_in" not in model_capabilities:
            omitted.add("video_in")
            new_content.append(
                system(
                    "Video omitted: model has no video_in capability. "
                    'Add capabilities = ["video_in"] to [models.<alias>] in config.toml.'
                )
            )
        else:
            new_content.append(part)

    if not omitted:
        return message, omitted

    return (
        Message(
            role=message.role,
            content=new_content,
            tool_calls=message.tool_calls,
            tool_call_id=message.tool_call_id,
        ),
        omitted,
    )
