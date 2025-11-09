"""Terminal theme detection utilities."""

import os


def detect_terminal_theme() -> str:
    """
    Detect whether the terminal is using a light or dark theme.

    Returns:
        "light" if light theme is detected, "dark" otherwise.

    Detection method:
        - Checks COLORFGBG environment variable (format: "foreground;background")
        - Background colors 0-6 and 8 are considered dark
        - Background color 7 and 15 are considered light
        - Falls back to "dark" if detection is not possible
    """
    colorfgbg = os.environ.get("COLORFGBG", "")

    if colorfgbg:
        # COLORFGBG format is typically "foreground;background"
        parts = colorfgbg.split(";")
        if len(parts) >= 2:
            try:
                bg_color = int(parts[-1])
                # Background colors 0-6 and 8 are dark, 7 and 15 are light
                # See: https://en.wikipedia.org/wiki/ANSI_escape_code#Colors
                if bg_color in (7, 15):
                    return "light"
            except ValueError:
                pass

    # Default to dark theme if we can't detect
    return "dark"


def get_code_theme() -> str:
    """
    Get the appropriate Pygments theme for code syntax highlighting
    based on the detected terminal theme.

    Returns:
        Theme name suitable for Pygments/Rich Syntax highlighting.
        - "github-light" for light terminals
        - "monokai" for dark terminals
    """
    theme = detect_terminal_theme()

    if theme == "light":
        # github-light is a clean, readable theme for light backgrounds
        return "github-light"
    else:
        # monokai is the existing theme for dark backgrounds
        return "monokai"
