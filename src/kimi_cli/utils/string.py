from __future__ import annotations

import random
import re
import secrets
import string

_NEWLINE_RE = re.compile(r"[\r\n]+")


def shorten_middle(text: str, width: int, remove_newline: bool = True) -> str:
    """Shorten the text by inserting ellipsis in the middle.

    Args:
        text: The input string to shorten.
        width: The maximum width of the output string.
        remove_newline: If True, replace newlines with spaces before shortening.

    Returns:
        The shortened string with "..." in the middle if truncation occurred,
        otherwise the original string.

    Example:
        >>> shorten_middle("hello world example", 15)
        'hello...example'
    """
    if len(text) <= width:
        return text
    if remove_newline:
        text = _NEWLINE_RE.sub(" ", text)
    return text[: width // 2] + "..." + text[-width // 2 :]


def random_string(length: int = 8) -> str:
    """Generate a cryptographically secure random string of fixed length.

    Uses secrets module for security-sensitive contexts (tokens, IDs).

    Args:
        length: The desired length of the random string (default: 8).

    Returns:
        A random lowercase ASCII string of the specified length.

    Example:
        >>> random_string(10)  # e.g., 'akdjeiwoqn'
    """
    letters = string.ascii_lowercase
    return "".join(secrets.choice(letters) for _ in range(length))
