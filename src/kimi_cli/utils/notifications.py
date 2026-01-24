"""Desktop notification utilities for terminal applications.

This module provides desktop notifications using OSC 9 escape sequences
(for modern terminals like Ghostty, iTerm2, Kitty, Windows Terminal).

Reference: https://iterm2.com/documentation-escape-codes.html
"""

from __future__ import annotations

import sys

from kimi_cli.utils.logging import logger


def notify(title: str, message: str) -> bool:
    """Send a desktop notification using OSC 9.

    Uses OSC 9 escape sequences which are supported by modern terminals
    including Ghostty, iTerm2, Kitty, Windows Terminal, and WezTerm.

    Format: \x1b]9;{message}\x07

    Reference: https://iterm2.com/documentation-escape-codes.html

    Args:
        title: The notification title.
        message: The notification body text.

    Returns:
        True if notification was sent successfully, False otherwise.
    """
    try:
        # Include title in the message body for OSC 9 since it doesn't
        # have a separate title field
        full_message = f"{title}: {message}" if title else message
        osc_sequence = f"\x1b]9;{full_message}\x07"
        sys.stdout.write(osc_sequence)
        sys.stdout.flush()
        return True
    except Exception as e:
        logger.warning(f"Failed to send notification: {e}")
        return False


def format_approval_notification(action: str, description: str, max_length: int = 100) -> str:
    """Format an approval request notification message.

    Args:
        action: The action being requested (e.g., "run command").
        description: The description of the action.
        max_length: Maximum length for the description.

    Returns:
        Formatted notification text.
    """
    # Truncate description if too long
    if len(description) > max_length:
        description = description[: max_length - 3] + "..."

    return f"{action}: {description}"


__all__ = ["notify", "format_approval_notification"]
