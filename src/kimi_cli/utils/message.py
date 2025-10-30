from kosong.base.message import Message, TextPart


def message_extract_text(message: Message) -> str:
    """Extract text from a message."""
    if isinstance(message.content, str):
        return message.content
    return "\n".join(part.text for part in message.content if isinstance(part, TextPart))


def message_stringify(message: Message) -> str:
    """Get a string representation of a message."""
    parts: list[str] = []
    if isinstance(message.content, str):
        parts.append(message.content)
    else:
        for part in message.content:
            if isinstance(part, TextPart):
                parts.append(part.text)
            else:
                parts.append(f"[{part.type}]")
    return "".join(parts)
