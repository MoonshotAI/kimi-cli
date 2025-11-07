"""Project-wide Rich configuration helpers."""

from __future__ import annotations

import re
from typing import Final

from rich import _wrap

# Regex used by Rich to compute break opportunities during wrapping.
_DEFAULT_WRAP_PATTERN: Final[re.Pattern[str]] = re.compile(r"\s*\S+\s*")
_CHAR_WRAP_PATTERN: Final[re.Pattern[str]] = re.compile(r".", re.DOTALL)


def enable_character_wrap() -> None:
    """Switch Rich's wrapping logic to break on every character.

    Rich's default behavior tries to preserve whole words; we override the
    internal regex so markdown rendering can fold text at any column once it
    exceeds the terminal width.
    """

    _wrap.re_word = _CHAR_WRAP_PATTERN


def restore_word_wrap() -> None:
    """Restore Rich's default word-based wrapping."""

    _wrap.re_word = _DEFAULT_WRAP_PATTERN


# Apply character-based wrapping globally for the CLI.
enable_character_wrap()
