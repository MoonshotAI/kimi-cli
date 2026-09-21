from __future__ import annotations

import random
import re
import string

_NEWLINE_RE = re.compile(r"[\r\n]+")


def shorten(text: str, *, width: int, placeholder: str = "…") -> str:
    """Shorten text to at most *width* characters.

    Normalises whitespace, then truncates — preferring a word boundary
    when one exists near the cut point, but falling back to a hard cut
    so that CJK text without spaces won't collapse to just the placeholder.
    """
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    cut = width - len(placeholder)
    if cut <= 0:
        return text[:width]
    space = text.rfind(" ", 0, cut + 1)
    if space > 0:
        cut = space
    return text[:cut].rstrip() + placeholder


def shorten_middle(text: str, width: int, remove_newline: bool = True) -> str:
    """Shorten the text by inserting ellipsis in the middle."""
    if len(text) <= width:
        return text
    if remove_newline:
        text = _NEWLINE_RE.sub(" ", text)
    return text[: width // 2] + "..." + text[-width // 2 :]


def random_string(length: int = 8) -> str:
    """Generate a random string of fixed length."""
    letters = string.ascii_lowercase
    return "".join(random.choice(letters) for _ in range(length))
