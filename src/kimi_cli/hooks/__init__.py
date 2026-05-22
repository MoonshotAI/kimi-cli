import shutil
import sys
from pathlib import Path

from kimi_cli.hooks.config import HOOK_EVENT_TYPES, HookDef, HookEventType
from kimi_cli.hooks.engine import HookEngine

__all__ = ["HookDef", "HookEventType", "HOOK_EVENT_TYPES", "HookEngine"]


def get_default_hooks() -> list[HookDef]:
    """Return default hooks that are auto-enabled when their dependencies are present."""
    hooks: list[HookDef] = []
    if shutil.which("rtk"):
        rtk_path = Path(__file__).parent / "defaults" / "rtk.py"
        hooks.append(
            HookDef(
                event="PreToolUse",
                matcher="Bash",
                command=f"{sys.executable} {rtk_path}",
                timeout=5,
            )
        )
    return hooks
