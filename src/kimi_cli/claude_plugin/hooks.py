"""Translate Claude plugin hooks/hooks.json into Kimi HookDef instances."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from kimi_cli.hooks.config import HOOK_EVENT_TYPES, HookDef
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from .spec import ClaudePluginRuntime

# Claude hook event names that map directly to Kimi event names.
_EVENT_MAP: dict[str, str] = {
    "SessionStart": "SessionStart",
    "SessionEnd": "SessionEnd",
    "PreToolUse": "PreToolUse",
    "PostToolUse": "PostToolUse",
    "Stop": "Stop",
    "Notification": "Notification",
    "SubagentStart": "SubagentStart",
    "SubagentStop": "SubagentStop",
    "UserPromptSubmit": "UserPromptSubmit",
}


def load_plugin_hooks(runtime: ClaudePluginRuntime) -> None:
    """Parse ``hooks/hooks.json`` and populate *runtime.hooks*."""
    hooks_path = runtime.root / "hooks" / "hooks.json"
    if not hooks_path.is_file():
        return

    try:
        raw: dict[str, Any] = json.loads(hooks_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        runtime.warnings.append(f"Invalid hooks/hooks.json: {exc}")
        logger.warning(
            "Invalid hooks/hooks.json in plugin '{name}': {error}",
            name=runtime.manifest.name,
            error=exc,
        )
        return

    hooks_section = raw.get("hooks", {})
    if not isinstance(hooks_section, dict):
        runtime.warnings.append("hooks/hooks.json 'hooks' key is not a dict")
        return

    plugin_root = runtime.root
    plugin_name = runtime.manifest.name

    section = cast(dict[str, Any], hooks_section)
    for event_name, groups_raw in section.items():
        kimi_event: str | None = _EVENT_MAP.get(event_name)
        if kimi_event is None:
            if event_name not in HOOK_EVENT_TYPES:
                runtime.warnings.append(
                    f"Unsupported hook event '{event_name}' in plugin '{plugin_name}'"
                )
                logger.warning(
                    "Unsupported Claude hook event '{event}' in plugin '{plugin}'",
                    event=event_name,
                    plugin=plugin_name,
                )
                continue
            kimi_event = event_name

        groups: list[Any] = (
            cast(list[Any], groups_raw) if isinstance(groups_raw, list) else [groups_raw]
        )

        for group in groups:
            if not isinstance(group, dict):
                continue
            g = cast(dict[str, Any], group)
            matcher = g.get("matcher", "")
            hook_entries = g.get("hooks", [])
            if not isinstance(hook_entries, list):
                hook_entries = [hook_entries]

            for entry in cast(list[Any], hook_entries):
                if not isinstance(entry, dict):
                    continue
                e = cast(dict[str, Any], entry)
                hook_type = e.get("type", "command")
                if hook_type != "command":
                    runtime.warnings.append(
                        f"Unsupported hook type '{hook_type}' in plugin '{plugin_name}'"
                    )
                    continue

                command = str(e.get("command", ""))
                if not command:
                    continue

                command = expand_plugin_root(command, plugin_root)

                try:
                    raw_timeout = int(e.get("timeout", 30))
                except (ValueError, TypeError) as exc:
                    runtime.warnings.append(
                        f"Invalid hook timeout in plugin '{plugin_name}': {exc}"
                    )
                    logger.warning(
                        "Invalid hook timeout in plugin '{plugin}': {error}",
                        plugin=plugin_name,
                        error=exc,
                    )
                    continue

                timeout = max(1, min(600, raw_timeout))

                try:
                    hook_def = HookDef(
                        event=kimi_event,  # type: ignore[arg-type]
                        command=command,
                        matcher=str(matcher),
                        timeout=timeout,
                    )
                    runtime.hooks.append(hook_def)
                except Exception as exc:
                    runtime.warnings.append(
                        f"Invalid hook entry in plugin '{plugin_name}': {exc}"
                    )
                    logger.warning(
                        "Invalid hook entry in plugin '{plugin}': {error}",
                        plugin=plugin_name,
                        error=exc,
                    )


def expand_plugin_root(value: str, plugin_root: Path) -> str:
    """Replace ``${CLAUDE_PLUGIN_ROOT}`` with the actual plugin directory."""
    return value.replace("${CLAUDE_PLUGIN_ROOT}", str(plugin_root))
