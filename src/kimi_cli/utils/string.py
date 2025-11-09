import random
import re
import string

_NEWLINE_RE = re.compile(r"[\r\n]+")


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


def sanitize_text(text: str) -> str:
    """Sanitize text by removing null bytes and other invalid characters.

    This function removes null bytes (\x00) that can cause UTF-8 validation
    errors when sending messages to LLM APIs. It preserves all other valid
    UTF-8 content.

    Args:
        text: The text to sanitize.

    Returns:
        The sanitized text with null bytes removed.
    """
    if not text:
        return text
    # Remove null bytes which are invalid in JSON strings and cause API errors
    return text.replace("\x00", "")
