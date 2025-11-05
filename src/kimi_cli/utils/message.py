from kosong.base.message import Message, TextPart

from kimi_cli.constants import LARGE_PASTE_LINE_THRESHOLD


def message_extract_text(message: Message) -> str:
    """Extract text from a message."""
    if isinstance(message.content, str):
        return message.content
    return "\n".join(part.text for part in message.content if isinstance(part, TextPart))


def message_stringify(message: Message, context: str = "default") -> str:
    """Return a string view of a message, collapsing large pastes outside replay context."""

    def _maybe_collapse(text: str) -> str:
        """Collapse text if it exceeds threshold (except in replay context)."""
        if context == "replay":
            return text
        line_count = text.count('\n') + 1
        if line_count > LARGE_PASTE_LINE_THRESHOLD:
            return f"[pasted {line_count} lines]"
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
