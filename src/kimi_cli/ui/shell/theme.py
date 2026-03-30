"""Theme configuration and color definitions for the shell UI.

This module provides theme support for Kimi Code CLI, including both dark and light
themes. The theme is configurable via the config file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

# Theme state (using a mutable container to avoid import snapshot issues)
_theme_state: dict[str, Literal["dark", "light"]] = {"theme": "dark"}


def detect_terminal_theme() -> Literal["dark", "light"]:
    """Auto-detect terminal theme based on environment variables.

    Checks COLORFGBG and TERM_BACKGROUND environment variables to determine
    if the terminal has a light or dark background.

    Returns:
        "light" if terminal appears to have light background, "dark" otherwise.
    """
    colorfgbg = os.environ.get("COLORFGBG", "")
    term_bg = os.environ.get("TERM_BACKGROUND")
    # COLORFGBG format: "fg;bg" where bg is 0-15
    # bg 0-8 = dark, 9-15 = light
    is_light = False
    if term_bg == "light":
        is_light = True
    elif colorfgbg:
        parts = colorfgbg.split(";")
        if len(parts) >= 2:
            try:
                bg = int(parts[1])
                is_light = bg >= 9
            except ValueError:
                pass
    return "light" if is_light else "dark"


def get_current_theme() -> Literal["dark", "light"]:
    """Get the current theme name."""
    return _theme_state["theme"]


def is_light_theme() -> bool:
    """Check if the current theme is light."""
    return _theme_state["theme"] == "light"


@dataclass(frozen=True)
class ThemeColors:
    """Color definitions for a theme.

    All colors are defined as Rich color names or hex codes.
    """

    # Toolbar colors
    toolbar_border: str
    toolbar_text: str
    toolbar_text_secondary: str
    toolbar_text_dim: str

    # Prompt colors
    prompt_separator: str
    prompt_placeholder: str
    prompt_plan_mode: str

    # Slash completion menu colors
    slash_menu_separator: str
    slash_menu_marker: str
    slash_menu_marker_current: str
    slash_menu_command: str
    slash_menu_command_current: str
    slash_menu_meta: str
    slash_menu_meta_current: str

    # Status colors
    status_yolo: str
    status_plan: str
    status_cwd: str
    status_git: str
    status_bg_task: str
    status_tips: str

    # Message colors
    message_info: str
    message_warning: str
    message_error: str
    message_success: str

    # Approval panel colors
    approval_border: str
    approval_title: str
    approval_warning: str
    approval_selected: str
    approval_unselected: str
    approval_hint: str
    approval_metadata: str

    # Usage panel colors
    usage_border: str
    usage_label: str
    usage_text: str
    usage_dim: str

    # General UI colors
    dim: str
    highlight: str
    accent: str

    # Diff colors
    diff_add_bg: str
    diff_del_bg: str
    diff_add_hl: str
    diff_del_hl: str


# Dark theme colors (default)
DARK_THEME = ThemeColors(
    # Toolbar
    toolbar_border="#4d4d4d",
    toolbar_text="#888888",
    toolbar_text_secondary="#666666",
    toolbar_text_dim="#555555",
    # Prompt
    prompt_separator="#4a5568",
    prompt_placeholder="#7c8594",
    prompt_plan_mode="#00aaff",
    # Slash completion menu
    slash_menu_separator="#4a5568",
    slash_menu_marker="#4a5568",
    slash_menu_marker_current="#4f9fff",
    slash_menu_command="#a6adba",
    slash_menu_command_current="#6fb7ff",
    slash_menu_meta="#7c8594",
    slash_menu_meta_current="#56a4ff",
    # Status
    status_yolo="#ffff00",
    status_plan="#00aaff",
    status_cwd="#666666",
    status_git="#666666",
    status_bg_task="#888888",
    status_tips="#555555",
    # Messages
    message_info="cyan",
    message_warning="yellow",
    message_error="red",
    message_success="green",
    # Approval panel
    approval_border="bold yellow",
    approval_title="bold yellow",
    approval_warning="yellow",
    approval_selected="cyan",
    approval_unselected="grey50",
    approval_hint="dim",
    approval_metadata="grey50",
    # Usage panel
    usage_border="wheat4",
    usage_label="cyan",
    usage_text="",
    usage_dim="grey50",
    # General
    dim="dim",
    highlight="cyan",
    accent="dodger_blue1",
    # Diff
    diff_add_bg="#12261e",
    diff_del_bg="#2d1214",
    diff_add_hl="#1a4a2e",
    diff_del_hl="#5c1a1d",
)

# Light theme colors
LIGHT_THEME = ThemeColors(
    # Toolbar
    toolbar_border="#c0c0c0",
    toolbar_text="#555555",
    toolbar_text_secondary="#666666",
    toolbar_text_dim="#888888",
    # Prompt
    prompt_separator="#a0a0a0",
    prompt_placeholder="#707070",
    prompt_plan_mode="#0066cc",
    # Slash completion menu
    slash_menu_separator="#a0a0a0",
    slash_menu_marker="#808080",
    slash_menu_marker_current="#0066cc",
    slash_menu_command="#333333",
    slash_menu_command_current="#0066cc",
    slash_menu_meta="#666666",
    slash_menu_meta_current="#0066cc",
    # Status
    status_yolo="#cc8800",
    status_plan="#0066cc",
    status_cwd="#555555",
    status_git="#555555",
    status_bg_task="#666666",
    status_tips="#888888",
    # Messages
    message_info="blue",
    message_warning="dark_orange",
    message_error="dark_red",
    message_success="dark_green",
    # Approval panel
    approval_border="bold dark_orange",
    approval_title="bold dark_orange",
    approval_warning="dark_orange",
    approval_selected="blue",
    approval_unselected="grey50",
    approval_hint="dim",
    approval_metadata="grey50",
    # Usage panel
    usage_border="grey50",
    usage_label="blue",
    usage_text="",
    usage_dim="grey50",
    # General
    dim="dim",
    highlight="blue",
    accent="blue",
    # Diff
    diff_add_bg="#d4edda",
    diff_del_bg="#f8d7da",
    diff_add_hl="#90EE90",
    diff_del_hl="#FFB6C1",
)


def get_theme_colors() -> ThemeColors:
    """Get the current theme colors.

    Returns the color scheme based on the current theme setting.
    """
    if _theme_state["theme"] == "light":
        return LIGHT_THEME
    return DARK_THEME


def set_theme(new_theme: Literal["dark", "light"]) -> None:
    """Set the current theme.

    Args:
        new_theme: The theme to use, either "dark" or "light".
    """
    _theme_state["theme"] = new_theme


def get_prompt_toolkit_style() -> dict[str, str]:
    """Get the prompt_toolkit style dictionary for the current theme.

    Returns:
        A dictionary mapping style classes to color definitions.
    """
    colors = get_theme_colors()
    return {
        "bottom-toolbar": "noreverse",
        "running-prompt-placeholder": f"fg:{colors.prompt_placeholder} italic",
        "running-prompt-separator": f"fg:{colors.prompt_separator}",
        "slash-completion-menu": "",
        "slash-completion-menu.separator": f"fg:{colors.slash_menu_separator}",
        "slash-completion-menu.marker": f"fg:{colors.slash_menu_marker}",
        "slash-completion-menu.marker.current": f"fg:{colors.slash_menu_marker_current}",
        "slash-completion-menu.command": f"fg:{colors.slash_menu_command}",
        "slash-completion-menu.meta": f"fg:{colors.slash_menu_meta}",
        "slash-completion-menu.command.current": f"fg:{colors.slash_menu_command_current} bold",
        "slash-completion-menu.meta.current": f"fg:{colors.slash_menu_meta_current}",
    }
