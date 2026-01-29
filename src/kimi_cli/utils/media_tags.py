from __future__ import annotations

from collections.abc import Mapping
from html import escape

from kimi_cli.wire.types import ContentPart, TextPart


def _format_tag(tag: str, attrs: Mapping[str, str | None] | None = None) -> str:
    if not attrs:
        return f"<{tag}>"
    rendered: list[str] = []
    for key, value in sorted(attrs.items()):
        if not value:
            continue
        rendered.append(f'{key}="{escape(str(value), quote=True)}"')
    if not rendered:
        return f"<{tag}>"
    return f"<{tag} " + " ".join(rendered) + ">"


def wrap_media_part(
    part: ContentPart, *, tag: str, attrs: Mapping[str, str | None] | None = None
) -> list[ContentPart]:
    return [
        TextPart(text=_format_tag(tag, attrs)),
        part,
        TextPart(text=f"</{tag}>"),
    ]
