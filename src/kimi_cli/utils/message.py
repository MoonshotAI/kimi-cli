from kosong.base.message import Message, TextPart

# Large paste display threshold (same as ui/shell/prompt.py)
LARGE_PASTE_WORD_THRESHOLD = 300


def message_extract_text(message: Message) -> str:
    """Extract text from a message."""
    if isinstance(message.content, str):
        return message.content
    return "\n".join(part.text for part in message.content if isinstance(part, TextPart))


def message_stringify(message: Message, context: str = "default") -> str:
    """
    Get a string representation of a message.

    Args:
        message: The message to stringify.
        context: Display context - "replay" shows full text, others collapse large pastes.
    """

    def _maybe_collapse(text: str) -> str:
        """Collapse text if it exceeds threshold (except in replay context)."""
        if context == "replay":
            return text
        word_count = len(text.split())
        if word_count > LARGE_PASTE_WORD_THRESHOLD:
            return f"[pasted {word_count} words]"
        return text

    parts: list[str] = []
    if isinstance(message.content, str):
        parts.append(_maybe_collapse(message.content))
    else:
        for part in message.content:
            if isinstance(part, TextPart):
                parts.append(_maybe_collapse(part.text))
            else:
                parts.append(f"[{part.type}]")
    return "".join(parts)
