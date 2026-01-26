from __future__ import annotations

from kosong.message import Message

from kimi_cli.wire.types import AudioURLPart, ImageURLPart, TextPart, VideoURLPart


def message_stringify(message: Message) -> str:
    """Get a string representation of a message."""
    # TODO: this should be merged into `kosong.message.Message.extract_text`
    parts: list[str] = []
    for part in message.content:
        if isinstance(part, TextPart):
            parts.append(part.text)
        elif isinstance(part, ImageURLPart):
            suffix = f":{part.image_url.id}" if part.image_url.id else ""
            parts.append(f"[image{suffix}]")
        elif isinstance(part, AudioURLPart):
            suffix = f":{part.audio_url.id}" if part.audio_url.id else ""
            parts.append(f"[audio{suffix}]")
        elif isinstance(part, VideoURLPart):
            suffix = f":{part.video_url.id}" if part.video_url.id else ""
            parts.append(f"[video{suffix}]")
        else:
            parts.append(f"[{part.type}]")
    return "".join(parts)
