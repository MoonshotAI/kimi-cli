from __future__ import annotations

import random
import re
import string
import unicodedata

_NEWLINE_RE = re.compile(r"[\r\n]+")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]+")
_WHITESPACE_RE = re.compile(r"\s+")


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


def sanitize_http_header_value(value: str, *, default: str = "unknown") -> str:
    """Return an ASCII-safe HTTP header value.

    Some HTTP client stacks (and servers) only accept ASCII in header values.
    This helper prevents crashes when system strings (e.g., hostname) include
    Unicode characters.
    """
    cleaned = value.replace("\r", " ").replace("\n", " ")
    cleaned = _CONTROL_CHARS_RE.sub(" ", cleaned)
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()

    try:
        cleaned.encode("ascii")
    except UnicodeEncodeError:
        normalized = unicodedata.normalize("NFKD", cleaned)
        cleaned = normalized.encode("ascii", errors="replace").decode("ascii").strip()

    return cleaned or default
