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
