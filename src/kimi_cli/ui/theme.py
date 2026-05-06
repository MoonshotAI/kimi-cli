"""Centralized terminal color theme definitions with custom skin support.

Built-in themes: dark, light.
Custom skins: load from ~/.kimi/skins/<name>.yaml (Hermes-compatible format).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from prompt_toolkit.styles import Style as PTKStyle
from rich.style import Style as RichStyle

# Optional YAML support
try:
    import yaml

    _HAS_YAML = True
except Exception:  # pragma: no cover
    _HAS_YAML = False

type ThemeName = Literal["dark", "light"]


# ---------------------------------------------------------------------------
# Skin dataclass — mirrors Hermes skin format
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SkinColors:
    """Color palette for a skin."""

    # Diff colors
    diff_add_bg: str = "#12261e"
    diff_add_hl: str = "#1a4a2e"
    diff_del_bg: str = "#2d1214"
    diff_del_hl: str = "#5c1a1d"

    # Task browser
    tb_header_bg: str = "#1f2937"
    tb_header_fg: str = "#e5e7eb"
    tb_header_title: str = "#67e8f9"
    tb_header_meta: str = "#9ca3af"
    tb_status_running: str = "#86efac"
    tb_status_success: str = "#86efac"
    tb_status_warning: str = "#fbbf24"
    tb_status_error: str = "#fca5a5"
    tb_status_info: str = "#93c5fd"
    tb_task_list_bg: str = "#111827"
    tb_task_list_fg: str = "#d1d5db"
    tb_task_list_checked_bg: str = "#164e63"
    tb_task_list_checked_fg: str = "#ecfeff"
    tb_frame_border: str = "#155e75"
    tb_frame_label_bg: str = "#0f172a"
    tb_frame_label_fg: str = "#67e8f9"
    tb_footer_bg: str = "#0f172a"
    tb_footer_fg: str = "#cbd5e1"
    tb_footer_key: str = "#67e8f9"
    tb_footer_warning_bg: str = "#7f1d1d"
    tb_footer_warning_fg: str = "#fecaca"
    tb_footer_meta: str = "#94a3b8"

    # Prompt / completion menu
    prompt_placeholder: str = "#7c8594"
    prompt_separator: str = "#4a5568"
    completion_separator: str = "#4a5568"
    completion_marker: str = "#4a5568"
    completion_marker_current: str = "#4f9fff"
    completion_command: str = "#a6adba"
    completion_meta: str = "#7c8594"
    completion_command_current: str = "#6fb7ff"
    completion_meta_current: str = "#56a4ff"

    # Toolbar
    toolbar_separator: str = "#4d4d4d"
    toolbar_yolo: str = "#ffff00"
    toolbar_afk: str = "#ff8800"
    toolbar_plan: str = "#00aaff"
    toolbar_cwd: str = "#666666"
    toolbar_bg_tasks: str = "#888888"
    toolbar_tip: str = "#555555"

    # MCP status
    mcp_text: str = "#d4d4d4"
    mcp_detail: str = "#7c8594"
    mcp_connected: str = "#56d364"
    mcp_connecting: str = "#56a4ff"
    mcp_pending: str = "#f2cc60"
    mcp_failed: str = "#ff7b72"


@dataclass(frozen=True, slots=True)
class SkinBranding:
    """Optional branding strings (inspired by Hermes)."""

    welcome: str = ""
    goodbye: str = ""
    prompt_symbol: str = ""


@dataclass(frozen=True, slots=True)
class Skin:
    """A complete terminal skin definition."""

    name: str
    description: str = ""
    colors: SkinColors = field(default_factory=SkinColors)
    branding: SkinBranding = field(default_factory=SkinBranding)
    font_hint: str = ""


# ---------------------------------------------------------------------------
# Built-in skins
# ---------------------------------------------------------------------------

_DARK_COLORS = SkinColors()

_LIGHT_COLORS = SkinColors(
    diff_add_bg="#dafbe1",
    diff_add_hl="#aff5b4",
    diff_del_bg="#ffebe9",
    diff_del_hl="#ffc1c0",
    tb_header_bg="#e5e7eb",
    tb_header_fg="#1f2937",
    tb_header_title="#0e7490",
    tb_header_meta="#6b7280",
    tb_status_running="#166534",
    tb_status_success="#166534",
    tb_status_warning="#92400e",
    tb_status_error="#991b1b",
    tb_status_info="#1e40af",
    tb_task_list_bg="#f9fafb",
    tb_task_list_fg="#374151",
    tb_task_list_checked_bg="#cffafe",
    tb_task_list_checked_fg="#164e63",
    tb_frame_border="#0e7490",
    tb_frame_label_bg="#f1f5f9",
    tb_frame_label_fg="#0e7490",
    tb_footer_bg="#f1f5f9",
    tb_footer_fg="#475569",
    tb_footer_key="#0e7490",
    tb_footer_warning_bg="#fee2e2",
    tb_footer_warning_fg="#991b1b",
    tb_footer_meta="#64748b",
    prompt_placeholder="#6b7280",
    prompt_separator="#d1d5db",
    completion_separator="#d1d5db",
    completion_marker="#9ca3af",
    completion_marker_current="#2563eb",
    completion_command="#4b5563",
    completion_meta="#6b7280",
    completion_command_current="#1d4ed8",
    completion_meta_current="#2563eb",
    toolbar_separator="#d1d5db",
    toolbar_yolo="#b45309",
    toolbar_afk="#c2410c",
    toolbar_plan="#2563eb",
    toolbar_cwd="#6b7280",
    toolbar_bg_tasks="#4b5563",
    toolbar_tip="#9ca3af",
    mcp_text="#374151",
    mcp_detail="#6b7280",
    mcp_connected="#166534",
    mcp_connecting="#1d4ed8",
    mcp_pending="#92400e",
    mcp_failed="#dc2626",
)

_BUILTIN_SKINS: dict[str, Skin] = {
    "dark": Skin(name="dark", description="Default dark terminal theme", colors=_DARK_COLORS),
    "light": Skin(name="light", description="Default light terminal theme", colors=_LIGHT_COLORS),
}


# ---------------------------------------------------------------------------
# Custom skin loading (Hermes-compatible YAML)
# ---------------------------------------------------------------------------


def _load_yaml_skin(path: Path) -> Skin | None:
    """Load a skin from a Hermes-compatible YAML file."""
    if not _HAS_YAML:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not data or not isinstance(data, dict):
            return None

        raw_colors = data.get("colors", {})
        colors = SkinColors(
            diff_add_bg=raw_colors.get("diff_add_bg", _DARK_COLORS.diff_add_bg),
            diff_add_hl=raw_colors.get("diff_add_hl", _DARK_COLORS.diff_add_hl),
            diff_del_bg=raw_colors.get("diff_del_bg", _DARK_COLORS.diff_del_bg),
            diff_del_hl=raw_colors.get("diff_del_hl", _DARK_COLORS.diff_del_hl),
            tb_header_bg=raw_colors.get("tb_header_bg", _DARK_COLORS.tb_header_bg),
            tb_header_fg=raw_colors.get("tb_header_fg", _DARK_COLORS.tb_header_fg),
            tb_header_title=raw_colors.get("tb_header_title", _DARK_COLORS.tb_header_title),
            tb_header_meta=raw_colors.get("tb_header_meta", _DARK_COLORS.tb_header_meta),
            tb_status_running=raw_colors.get("tb_status_running", _DARK_COLORS.tb_status_running),
            tb_status_success=raw_colors.get("tb_status_success", _DARK_COLORS.tb_status_success),
            tb_status_warning=raw_colors.get("tb_status_warning", _DARK_COLORS.tb_status_warning),
            tb_status_error=raw_colors.get("tb_status_error", _DARK_COLORS.tb_status_error),
            tb_status_info=raw_colors.get("tb_status_info", _DARK_COLORS.tb_status_info),
            tb_task_list_bg=raw_colors.get("tb_task_list_bg", _DARK_COLORS.tb_task_list_bg),
            tb_task_list_fg=raw_colors.get("tb_task_list_fg", _DARK_COLORS.tb_task_list_fg),
            tb_task_list_checked_bg=raw_colors.get(
                "tb_task_list_checked_bg", _DARK_COLORS.tb_task_list_checked_bg
            ),
            tb_task_list_checked_fg=raw_colors.get(
                "tb_task_list_checked_fg", _DARK_COLORS.tb_task_list_checked_fg
            ),
            tb_frame_border=raw_colors.get("tb_frame_border", _DARK_COLORS.tb_frame_border),
            tb_frame_label_bg=raw_colors.get("tb_frame_label_bg", _DARK_COLORS.tb_frame_label_bg),
            tb_frame_label_fg=raw_colors.get("tb_frame_label_fg", _DARK_COLORS.tb_frame_label_fg),
            tb_footer_bg=raw_colors.get("tb_footer_bg", _DARK_COLORS.tb_footer_bg),
            tb_footer_fg=raw_colors.get("tb_footer_fg", _DARK_COLORS.tb_footer_fg),
            tb_footer_key=raw_colors.get("tb_footer_key", _DARK_COLORS.tb_footer_key),
            tb_footer_warning_bg=raw_colors.get(
                "tb_footer_warning_bg", _DARK_COLORS.tb_footer_warning_bg
            ),
            tb_footer_warning_fg=raw_colors.get(
                "tb_footer_warning_fg", _DARK_COLORS.tb_footer_warning_fg
            ),
            tb_footer_meta=raw_colors.get("tb_footer_meta", _DARK_COLORS.tb_footer_meta),
            prompt_placeholder=raw_colors.get("prompt_placeholder", _DARK_COLORS.prompt_placeholder),
            prompt_separator=raw_colors.get("prompt_separator", _DARK_COLORS.prompt_separator),
            completion_separator=raw_colors.get(
                "completion_separator", _DARK_COLORS.completion_separator
            ),
            completion_marker=raw_colors.get("completion_marker", _DARK_COLORS.completion_marker),
            completion_marker_current=raw_colors.get(
                "completion_marker_current", _DARK_COLORS.completion_marker_current
            ),
            completion_command=raw_colors.get("completion_command", _DARK_COLORS.completion_command),
            completion_meta=raw_colors.get("completion_meta", _DARK_COLORS.completion_meta),
            completion_command_current=raw_colors.get(
                "completion_command_current", _DARK_COLORS.completion_command_current
            ),
            completion_meta_current=raw_colors.get(
                "completion_meta_current", _DARK_COLORS.completion_meta_current
            ),
            toolbar_separator=raw_colors.get("toolbar_separator", _DARK_COLORS.toolbar_separator),
            toolbar_yolo=raw_colors.get("toolbar_yolo", _DARK_COLORS.toolbar_yolo),
            toolbar_afk=raw_colors.get("toolbar_afk", _DARK_COLORS.toolbar_afk),
            toolbar_plan=raw_colors.get("toolbar_plan", _DARK_COLORS.toolbar_plan),
            toolbar_cwd=raw_colors.get("toolbar_cwd", _DARK_COLORS.toolbar_cwd),
            toolbar_bg_tasks=raw_colors.get("toolbar_bg_tasks", _DARK_COLORS.toolbar_bg_tasks),
            toolbar_tip=raw_colors.get("toolbar_tip", _DARK_COLORS.toolbar_tip),
            mcp_text=raw_colors.get("mcp_text", _DARK_COLORS.mcp_text),
            mcp_detail=raw_colors.get("mcp_detail", _DARK_COLORS.mcp_detail),
            mcp_connected=raw_colors.get("mcp_connected", _DARK_COLORS.mcp_connected),
            mcp_connecting=raw_colors.get("mcp_connecting", _DARK_COLORS.mcp_connecting),
            mcp_pending=raw_colors.get("mcp_pending", _DARK_COLORS.mcp_pending),
            mcp_failed=raw_colors.get("mcp_failed", _DARK_COLORS.mcp_failed),
        )

        raw_branding = data.get("branding", {})
        branding = SkinBranding(
            welcome=raw_branding.get("welcome", ""),
            goodbye=raw_branding.get("goodbye", ""),
            prompt_symbol=raw_branding.get("prompt_symbol", ""),
        )

        return Skin(
            name=data.get("name", path.stem),
            description=data.get("description", ""),
            colors=colors,
            branding=branding,
            font_hint=data.get("font", {}).get("primary", "") if isinstance(data.get("font"), dict) else "",
        )
    except Exception:
        return None


def _discover_custom_skins() -> dict[str, Skin]:
    """Discover skins in ~/.kimi/skins/*.yaml."""
    skins: dict[str, Skin] = {}
    skins_dir = Path.home() / ".kimi" / "skins"
    if not skins_dir.exists():
        return skins
    for path in skins_dir.glob("*.yaml"):
        skin = _load_yaml_skin(path)
        if skin:
            skins[skin.name] = skin
    return skins


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_active_skin_name: str = "dark"
_custom_skins: dict[str, Skin] = {}


def _all_skins() -> dict[str, Skin]:
    """Return built-in + discovered custom skins."""
    global _custom_skins
    # Re-discover on each call so new files are picked up without restart
    _custom_skins = _discover_custom_skins()
    return {**_BUILTIN_SKINS, **_custom_skins}


def set_active_skin(name: str) -> bool:
    """Activate a skin by name. Returns True if found."""
    global _active_skin_name
    all_skins = _all_skins()
    if name not in all_skins:
        return False
    _active_skin_name = name
    return True


def get_active_skin() -> Skin:
    """Return the currently active skin."""
    all_skins = _all_skins()
    return all_skins.get(_active_skin_name, _BUILTIN_SKINS["dark"])


def get_active_skin_name() -> str:
    """Return the name of the currently active skin."""
    return _active_skin_name


def list_skins() -> list[tuple[str, str]]:
    """List all available skins as (name, description) tuples."""
    return [(s.name, s.description) for s in _all_skins().values()]


def get_skin_branding() -> SkinBranding:
    """Return branding for the active skin (if any)."""
    return get_active_skin().branding


# ---------------------------------------------------------------------------
# Backwards compatibility: theme → skin mapping
# ---------------------------------------------------------------------------


def set_active_theme(theme: ThemeName) -> None:
    """Legacy API: set theme by name."""
    global _active_skin_name
    _active_skin_name = theme


def get_active_theme() -> ThemeName:
    """Legacy API: return 'dark' or 'light'."""
    name = _active_skin_name
    if name in ("dark", "light"):
        return name  # type: ignore[return-value]
    # Custom skins default to dark behavior for legacy callers
    return "dark"


# ---------------------------------------------------------------------------
# Color resolvers (skin-aware)
# ---------------------------------------------------------------------------


def _c() -> SkinColors:
    """Shorthand for active skin colors."""
    return get_active_skin().colors


# ---------------------------------------------------------------------------
# Diff colors (used by utils/rich/diff_render.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DiffColors:
    add_bg: RichStyle
    del_bg: RichStyle
    add_hl: RichStyle
    del_hl: RichStyle


def get_diff_colors() -> DiffColors:
    c = _c()
    return DiffColors(
        add_bg=RichStyle(bgcolor=c.diff_add_bg),
        del_bg=RichStyle(bgcolor=c.diff_del_bg),
        add_hl=RichStyle(bgcolor=c.diff_add_hl),
        del_hl=RichStyle(bgcolor=c.diff_del_hl),
    )


# ---------------------------------------------------------------------------
# Task browser colors (used by ui/shell/task_browser.py)
# ---------------------------------------------------------------------------


def get_task_browser_style() -> PTKStyle:
    c = _c()
    return PTKStyle.from_dict(
        {
            "header": f"bg:{c.tb_header_bg} {c.tb_header_fg}",
            "header.title": f"bg:{c.tb_header_bg} {c.tb_header_title} bold",
            "header.meta": f"bg:{c.tb_header_bg} {c.tb_header_meta}",
            "status.running": f"bg:{c.tb_header_bg} {c.tb_status_running} bold",
            "status.success": f"bg:{c.tb_header_bg} {c.tb_status_success}",
            "status.warning": f"bg:{c.tb_header_bg} {c.tb_status_warning}",
            "status.error": f"bg:{c.tb_header_bg} {c.tb_status_error}",
            "status.info": f"bg:{c.tb_header_bg} {c.tb_status_info}",
            "task-list": f"bg:{c.tb_task_list_bg} {c.tb_task_list_fg}",
            "task-list.checked": f"bg:{c.tb_task_list_checked_bg} {c.tb_task_list_checked_fg} bold",
            "frame.border": c.tb_frame_border,
            "frame.label": f"bg:{c.tb_frame_label_bg} {c.tb_frame_label_fg} bold",
            "footer": f"bg:{c.tb_footer_bg} {c.tb_footer_fg}",
            "footer.key": f"bg:{c.tb_footer_bg} {c.tb_footer_key} bold",
            "footer.text": f"bg:{c.tb_footer_bg} {c.tb_footer_fg}",
            "footer.warning": f"bg:{c.tb_footer_warning_bg} {c.tb_footer_warning_fg} bold",
            "footer.meta": f"bg:{c.tb_footer_bg} {c.tb_footer_meta}",
        }
    )


# ---------------------------------------------------------------------------
# Prompt / completion menu colors (used by ui/shell/prompt.py)
# ---------------------------------------------------------------------------


def get_prompt_style() -> PTKStyle:
    c = _c()
    d = {
        "bottom-toolbar": "noreverse",
        "running-prompt-placeholder": f"fg:{c.prompt_placeholder} italic",
        "running-prompt-separator": f"fg:{c.prompt_separator}",
        "slash-completion-menu": "",
        "slash-completion-menu.separator": f"fg:{c.completion_separator}",
        "slash-completion-menu.marker": f"fg:{c.completion_marker}",
        "slash-completion-menu.marker.current": f"fg:{c.completion_marker_current}",
        "slash-completion-menu.command": f"fg:{c.completion_command}",
        "slash-completion-menu.meta": f"fg:{c.completion_meta}",
        "slash-completion-menu.command.current": f"fg:{c.completion_command_current} bold",
        "slash-completion-menu.meta.current": f"fg:{c.completion_meta_current}",
    }
    return PTKStyle.from_dict(d)


# ---------------------------------------------------------------------------
# Bottom toolbar fragment colors (used by ui/shell/prompt.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ToolbarColors:
    separator: str
    yolo_label: str
    afk_label: str
    plan_label: str
    plan_prompt: str
    cwd: str
    bg_tasks: str
    tip: str


def get_toolbar_colors() -> ToolbarColors:
    c = _c()
    return ToolbarColors(
        separator=f"fg:{c.toolbar_separator}",
        yolo_label=f"bold fg:{c.toolbar_yolo}",
        afk_label=f"bold fg:{c.toolbar_afk}",
        plan_label=f"bold fg:{c.toolbar_plan}",
        plan_prompt=f"fg:{c.toolbar_plan}",
        cwd=f"fg:{c.toolbar_cwd}",
        bg_tasks=f"fg:{c.toolbar_bg_tasks}",
        tip=f"fg:{c.toolbar_tip}",
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


def get_mcp_prompt_colors() -> MCPPromptColors:
    c = _c()
    return MCPPromptColors(
        text=f"fg:{c.mcp_text}",
        detail=f"fg:{c.mcp_detail}",
        connected=f"fg:{c.mcp_connected}",
        connecting=f"fg:{c.mcp_connecting}",
        pending=f"fg:{c.mcp_pending}",
        failed=f"fg:{c.mcp_failed}",
    )
