from __future__ import annotations

from kosong.message import ContentPart, Message

from kimi_cli.wire.types import AudioURLPart, ImageURLPart, TextPart, VideoURLPart


def user_input_to_text(user_input: str | list[ContentPart]) -> str:
    """Extract the plain text from user input.

    ``user_input`` may be a plain string or structured content (e.g. the parts
    produced by the interactive shell UI). Return the concatenated text in both
    cases so text-based consumers (such as prompt-matching hooks) work
    regardless of the input shape.
    """
    if isinstance(user_input, str):
        return user_input
    return Message(role="user", content=user_input).extract_text(" ")


def message_stringify(message: Message) -> str:
    """Get a string representation of a message."""
    # TODO: this should be merged into `kosong.message.Message.extract_text`
    parts: list[str] = []
    for part in message.content:
        if isinstance(part, TextPart):
            parts.append(part.text)
        elif isinstance(part, ImageURLPart):
            parts.append("[image]")
        elif isinstance(part, AudioURLPart):
            suffix = f":{part.audio_url.id}" if part.audio_url.id else ""
            parts.append(f"[audio{suffix}]")
        elif isinstance(part, VideoURLPart):
            parts.append("[video]")
        else:
            parts.append(f"[{part.type}]")
    return "".join(parts)
