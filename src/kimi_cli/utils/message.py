from kosong.base.message import Message, TextPart


def message_extract_text(message: Message) -> str:
    """Extract text from a message."""
    if isinstance(message.content, str):
        return message.content
    return "\n".join(part.text for part in message.content if isinstance(part, TextPart))


def message_stringify(message: Message) -> str:
    """Get a string representation of a message."""
    s = ""
    if isinstance(message.content, str):
        s += message.content
    else:
        for part in message.content:
            if isinstance(part, TextPart):
                s += part.text
            else:
                s += f"[{part.type}]"
    return s
