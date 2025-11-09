import os
import sys

from rich.console import Console
from rich.theme import Theme

from kimi_cli.utils.logging import logger

_NEUTRAL_MARKDOWN_THEME = Theme(
    {
        "markdown.paragraph": "none",
        "markdown.block_quote": "none",
        "markdown.hr": "none",
        "markdown.item": "none",
        "markdown.item.bullet": "none",
        "markdown.item.number": "none",
        "markdown.link": "none",
        "markdown.link_url": "none",
        "markdown.h1": "none",
        "markdown.h1.border": "none",
        "markdown.h2": "none",
        "markdown.h3": "none",
        "markdown.h4": "none",
        "markdown.h5": "none",
        "markdown.h6": "none",
        "markdown.em": "none",
        "markdown.strong": "none",
        "markdown.s": "none",
        "status.spinner": "none",
    },
    inherit=True,
)


def _get_console_width() -> int | None:
    """
    Detect the terminal width with a safety margin to prevent character truncation.

    This function addresses Issue #208 where the last 2 characters of lines were being
    trimmed in WSL2 and other environments due to incorrect width detection.

    Returns:
        int | None: The detected width with safety margin, or None to use auto-detection.
    """
    # Allow manual override via environment variable
    env_width = os.environ.get("KIMI_CONSOLE_WIDTH")
    if env_width:
        try:
            width = int(env_width)
            logger.debug("Using console width from KIMI_CONSOLE_WIDTH: {width}", width=width)
            return width
        except ValueError:
            logger.warning(
                "Invalid KIMI_CONSOLE_WIDTH value: {env_width}, falling back to auto-detection",
                env_width=env_width,
            )

    # Try to detect terminal size
    try:
        size = os.get_terminal_size(sys.stdout.fileno())
        detected_width = size.columns

        # Apply safety margin to prevent character truncation
        # Subtract 2 characters to account for terminal width detection inaccuracies
        # in WSL2 and other environments
        safe_width = max(80, detected_width - 2)

        logger.debug(
            "Detected terminal width: {detected}, using safe width: {safe}",
            detected=detected_width,
            safe=safe_width,
        )
        return safe_width
    except (AttributeError, ValueError, OSError) as e:
        logger.debug("Failed to detect terminal width: {error}, using auto-detection", error=e)
        return None


console = Console(
    highlight=False,
    theme=_NEUTRAL_MARKDOWN_THEME,
    width=_get_console_width(),
)
