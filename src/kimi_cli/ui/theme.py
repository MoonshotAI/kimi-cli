"""Centralized terminal color theme definitions.

All UI-facing colors live here so that switching between dark and light
terminal themes only requires changing the active ``ThemeName``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from prompt_toolkit.styles import Style as PTKStyle
from rich.style import Style as RichStyle

type ThemeName = Literal["dark", "light"]


# ---------------------------------------------------------------------------
# Diff colors (used by utils/rich/diff_render.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DiffColors:
    add_bg: RichStyle
    del_bg: RichStyle
    add_hl: RichStyle
    del_hl: RichStyle


_DIFF_DARK = DiffColors(
    add_bg=RichStyle(bgcolor="#12261e"),
    del_bg=RichStyle(bgcolor="#2d1214"),
    add_hl=RichStyle(bgcolor="#1a4a2e"),
    del_hl=RichStyle(bgcolor="#5c1a1d"),
)

_DIFF_LIGHT = DiffColors(
    add_bg=RichStyle(bgcolor="#dafbe1"),
    del_bg=RichStyle(bgcolor="#ffebe9"),
    add_hl=RichStyle(bgcolor="#aff5b4"),
    del_hl=RichStyle(bgcolor="#ffc1c0"),
)


# ---------------------------------------------------------------------------
# Task browser colors (used by ui/shell/task_browser.py)
# ---------------------------------------------------------------------------


def _task_browser_style_dark() -> PTKStyle:
    return PTKStyle.from_dict(
        {
            "header": "bg:#1f2937 #e5e7eb",
            "header.title": "bg:#1f2937 #67e8f9 bold",
            "header.meta": "bg:#1f2937 #9ca3af",
            "status.running": "bg:#1f2937 #86efac bold",
            "status.success": "bg:#1f2937 #86efac",
            "status.warning": "bg:#1f2937 #fbbf24",
            "status.error": "bg:#1f2937 #fca5a5",
            "status.info": "bg:#1f2937 #93c5fd",
            "task-list": "bg:#111827 #d1d5db",
            "task-list.checked": "bg:#164e63 #ecfeff bold",
            "frame.border": "#155e75",
            "frame.label": "bg:#0f172a #67e8f9 bold",
            "footer": "bg:#0f172a #cbd5e1",
            "footer.key": "bg:#0f172a #67e8f9 bold",
            "footer.text": "bg:#0f172a #cbd5e1",
            "footer.warning": "bg:#7f1d1d #fecaca bold",
            "footer.meta": "bg:#0f172a #94a3b8",
        }
    )


def _task_browser_style_light() -> PTKStyle:
    return PTKStyle.from_dict(
        {
            "header": "bg:#e5e7eb #1f2937",
            "header.title": "bg:#e5e7eb #0e7490 bold",
            "header.meta": "bg:#e5e7eb #6b7280",
            "status.running": "bg:#e5e7eb #166534 bold",
            "status.success": "bg:#e5e7eb #166534",
            "status.warning": "bg:#e5e7eb #92400e",
            "status.error": "bg:#e5e7eb #991b1b",
            "status.info": "bg:#e5e7eb #1e40af",
            "task-list": "bg:#f9fafb #374151",
            "task-list.checked": "bg:#cffafe #164e63 bold",
            "frame.border": "#0e7490",
            "frame.label": "bg:#f1f5f9 #0e7490 bold",
            "footer": "bg:#f1f5f9 #475569",
            "footer.key": "bg:#f1f5f9 #0e7490 bold",
            "footer.text": "bg:#f1f5f9 #475569",
            "footer.warning": "bg:#fee2e2 #991b1b bold",
            "footer.meta": "bg:#f1f5f9 #64748b",
        }
    )


# ---------------------------------------------------------------------------
# Prompt / completion menu colors (used by ui/shell/prompt.py)
# ---------------------------------------------------------------------------


_PROMPT_STYLE_DARK = {
    "bottom-toolbar": "noreverse",
    "running-prompt-placeholder": "fg:#7c8594 italic",
    "running-prompt-separator": "fg:#4a5568",
    "slash-completion-menu": "",
    "slash-completion-menu.separator": "fg:#4a5568",
    "slash-completion-menu.marker": "fg:#4a5568",
    "slash-completion-menu.marker.current": "fg:#4f9fff",
    "slash-completion-menu.command": "fg:#a6adba",
    "slash-completion-menu.meta": "fg:#7c8594",
    "slash-completion-menu.command.current": "fg:#6fb7ff bold",
    "slash-completion-menu.meta.current": "fg:#56a4ff",
}

_PROMPT_STYLE_LIGHT = {
    "bottom-toolbar": "noreverse",
    "running-prompt-placeholder": "fg:#6b7280 italic",
    "running-prompt-separator": "fg:#d1d5db",
    "slash-completion-menu": "",
    "slash-completion-menu.separator": "fg:#d1d5db",
    "slash-completion-menu.marker": "fg:#9ca3af",
    "slash-completion-menu.marker.current": "fg:#2563eb",
    "slash-completion-menu.command": "fg:#4b5563",
    "slash-completion-menu.meta": "fg:#6b7280",
    "slash-completion-menu.command.current": "fg:#1d4ed8 bold",
    "slash-completion-menu.meta.current": "fg:#2563eb",
}


# ---------------------------------------------------------------------------
# Bottom toolbar fragment colors (used by ui/shell/prompt.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ToolbarColors:
    separator: str
    yolo_label: str
    plan_label: str
    plan_prompt: str
    cwd: str
    bg_tasks: str
    tip: str
    context_ok: str
    context_warn: str
    context_critical: str
    context_dim_ok: str
    context_dim_warn: str
    context_dim_critical: str


_TOOLBAR_DARK = ToolbarColors(
    separator="fg:#4d4d4d",
    yolo_label="bold fg:#ffff00",
    plan_label="bold fg:#00aaff",
    plan_prompt="fg:#00aaff",
    cwd="fg:#666666",
    bg_tasks="fg:#888888",
    tip="fg:#555555",
    context_ok="fg:#4ade80",
    context_warn="fg:#fbbf24",
    context_critical="fg:#f87171",
    context_dim_ok="fg:#166534",
    context_dim_warn="fg:#713f12",
    context_dim_critical="fg:#7f1d1d",
)

_TOOLBAR_LIGHT = ToolbarColors(
    separator="fg:#d1d5db",
    yolo_label="bold fg:#b45309",
    plan_label="bold fg:#2563eb",
    plan_prompt="fg:#2563eb",
    cwd="fg:#6b7280",
    bg_tasks="fg:#4b5563",
    tip="fg:#9ca3af",
    context_ok="fg:#16a34a",
    context_warn="fg:#d97706",
    context_critical="fg:#dc2626",
    context_dim_ok="fg:#bbf7d0",
    context_dim_warn="fg:#fef3c7",
    context_dim_critical="fg:#fecaca",
)


# ---------------------------------------------------------------------------
# MCP status prompt colors (used by ui/shell/mcp_status.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MCPPromptColors:
    text: str
    detail: str
    connected: str
    connecting: str
    pending: str
    failed: str


_MCP_PROMPT_DARK = MCPPromptColors(
    text="fg:#d4d4d4",
    detail="fg:#7c8594",
    connected="fg:#56d364",
    connecting="fg:#56a4ff",
    pending="fg:#f2cc60",
    failed="fg:#ff7b72",
)

_MCP_PROMPT_LIGHT = MCPPromptColors(
    text="fg:#374151",
    detail="fg:#6b7280",
    connected="fg:#166534",
    connecting="fg:#1d4ed8",
    pending="fg:#92400e",
    failed="fg:#dc2626",
)


# ---------------------------------------------------------------------------
# Public API — resolve by theme name
# ---------------------------------------------------------------------------

_active_theme: ThemeName = "dark"


def set_active_theme(theme: ThemeName) -> None:
    global _active_theme
    _active_theme = theme


def get_active_theme() -> ThemeName:
    return _active_theme


def get_diff_colors() -> DiffColors:
    return _DIFF_LIGHT if _active_theme == "light" else _DIFF_DARK


def get_task_browser_style() -> PTKStyle:
    return _task_browser_style_light() if _active_theme == "light" else _task_browser_style_dark()


def get_prompt_style() -> PTKStyle:
    d = _PROMPT_STYLE_LIGHT if _active_theme == "light" else _PROMPT_STYLE_DARK
    return PTKStyle.from_dict(d)


def get_toolbar_colors() -> ToolbarColors:
    return _TOOLBAR_LIGHT if _active_theme == "light" else _TOOLBAR_DARK


def get_mcp_prompt_colors() -> MCPPromptColors:
    return _MCP_PROMPT_LIGHT if _active_theme == "light" else _MCP_PROMPT_DARK
