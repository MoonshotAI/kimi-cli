"""Hook discovery logic."""

import os
from pathlib import Path
from typing import Optional

from .models import HookProperties
from .parser import read_properties


DEFAULT_USER_HOOKS_DIR = Path.home() / ".config" / "agents" / "hooks"
DEFAULT_PROJECT_HOOKS_DIR = Path(".agents") / "hooks"


def _get_xdg_hooks_dir() -> Path:
    """Get XDG-compliant hooks directory.

    Respects XDG_CONFIG_HOME environment variable.
    """
    xdg_config_home = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config_home:
        return Path(xdg_config_home) / "agents" / "hooks"
    return DEFAULT_USER_HOOKS_DIR


def discover_user_hooks() -> list[Path]:
    """Discover user-level hooks.

    Returns:
        List of paths to hook directories
    """
    hooks_dir = _get_xdg_hooks_dir()
    return discover_hooks_in_dir(hooks_dir)


def discover_project_hooks(project_dir: Optional[Path] = None) -> list[Path]:
    """Discover project-level hooks.

    Args:
        project_dir: Project root directory (default: current directory)

    Returns:
        List of paths to hook directories
    """
    if project_dir is None:
        project_dir = Path.cwd()

    hooks_dir = project_dir / DEFAULT_PROJECT_HOOKS_DIR
    return discover_hooks_in_dir(hooks_dir)


def discover_hooks_in_dir(hooks_dir: Path) -> list[Path]:
    """Discover all hooks in a hooks directory.

    Args:
        hooks_dir: Directory containing hook subdirectories

    Returns:
        List of paths to hook directories containing HOOK.md
    """
    hooks_dir = Path(hooks_dir)

    if not hooks_dir.exists() or not hooks_dir.is_dir():
        return []

    hook_dirs = []
    for item in hooks_dir.iterdir():
        if item.is_dir():
            hook_md = item / "HOOK.md"
            if hook_md.exists():
                hook_dirs.append(item)

    return sorted(hook_dirs)


def discover_all_hooks(project_dir: Optional[Path] = None) -> dict[str, list[Path]]:
    """Discover all hooks (user-level and project-level).

    Args:
        project_dir: Project root directory (default: current directory)

    Returns:
        Dictionary with 'user' and 'project' keys containing hook paths
    """
    return {
        "user": discover_user_hooks(),
        "project": discover_project_hooks(project_dir),
    }


def load_hooks(project_dir: Optional[Path] = None) -> list[HookProperties]:
    """Load all hooks from discovery paths.

    Project-level hooks override user-level hooks with the same name.

    Args:
        project_dir: Project root directory (default: current directory)

    Returns:
        List of HookProperties, sorted by priority (highest first)
    """
    discovered = discover_all_hooks(project_dir)

    # Load user hooks first
    hooks_by_name: dict[str, HookProperties] = {}
    for hook_dir in discovered["user"]:
        try:
            props = read_properties(hook_dir)
            hooks_by_name[props.name] = props
        except Exception:
            # Skip invalid hooks
            pass

    # Override with project hooks
    for hook_dir in discovered["project"]:
        try:
            props = read_properties(hook_dir)
            hooks_by_name[props.name] = props
        except Exception:
            pass

    # Sort by priority (descending)
    return sorted(hooks_by_name.values(), key=lambda h: h.priority, reverse=True)


def load_hooks_by_trigger(
    trigger: str, project_dir: Optional[Path] = None
) -> list[HookProperties]:
    """Load hooks filtered by trigger type.

    Args:
        trigger: Trigger event type (e.g., 'before_tool')
        project_dir: Project root directory (default: current directory)

    Returns:
        List of HookProperties matching the trigger, sorted by priority
    """
    all_hooks = load_hooks(project_dir)
    return [h for h in all_hooks if h.trigger.value == trigger]
