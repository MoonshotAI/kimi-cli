from __future__ import annotations

from kosong.message import Message

from kimi_cli.wire.types import TextPart


def message_stringify(message: Message) -> str:
    """Get a string representation of a message."""
    # TODO: this should be merged into `kosong.message.Message.extract_text`
    parts: list[str] = []
    for part in message.content:
        if isinstance(part, TextPart):
            parts.append(part.text)
        else:
            parts.append(f"[{part.type}]")
    return "".join(parts)
