"""Discover and load local Claude plugin directories."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from kimi_cli.utils.logging import logger

from .spec import (
    ClaudePluginBundle,
    ClaudePluginManifest,
    ClaudePluginRuntime,
)


def get_claude_plugins_dir() -> Path:
    """Return the default auto-discovery directory for Claude-compatible plugins.

    This is ``~/.kimi/claude-plugins/`` (or ``$KIMI_SHARE_DIR/claude-plugins/``).
    The directory is **not** created automatically — if it does not exist, auto-
    discovery simply finds nothing.
    """
    from kimi_cli.share import get_share_dir

    # get_share_dir() creates ~/.kimi/ but we intentionally do NOT create
    # the claude-plugins/ subdirectory; it must be user-created.
    return get_share_dir() / "claude-plugins"


def discover_default_claude_plugin_dirs() -> list[Path]:
    """Scan ``~/.kimi/claude-plugins/`` for valid Claude plugin subdirectories.

    Returns resolved paths for every immediate child directory that contains
    ``.claude-plugin/plugin.json``.  Returns an empty list when the parent
    directory does not exist.
    """
    base = get_claude_plugins_dir()
    if not base.is_dir():
        return []

    dirs: list[Path] = []
    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        if (entry / ".claude-plugin" / "plugin.json").is_file():
            dirs.append(entry.resolve())
            logger.info(
                "Auto-discovered Claude plugin directory: {path}",
                path=entry,
            )
    return dirs


def load_claude_plugins(plugin_dirs: Sequence[Path]) -> ClaudePluginBundle:
    """Load all Claude plugin directories and return a consolidated bundle.

    Each directory must contain ``.claude-plugin/plugin.json``.  Invalid
    directories are skipped with a warning.  Duplicate plugin names are
    rejected (first-wins).
    """
    plugins: dict[str, ClaudePluginRuntime] = {}

    for plugin_dir in plugin_dirs:
        try:
            runtime = _load_single_plugin(plugin_dir)
        except Exception as exc:
            logger.warning(
                "Skipping invalid Claude plugin at {path}: {error}",
                path=plugin_dir,
                error=exc,
            )
            continue

        name = runtime.manifest.name
        if name in plugins:
            logger.warning(
                "Duplicate Claude plugin name '{name}', skipping {path}",
                name=name,
                path=plugin_dir,
            )
            continue

        plugins[name] = runtime
        logger.info(
            "Loaded Claude plugin '{name}' from {path}",
            name=name,
            path=plugin_dir,
        )

    return ClaudePluginBundle(plugins=plugins)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load_single_plugin(plugin_dir: Path) -> ClaudePluginRuntime:
    """Parse a single Claude plugin directory into a runtime object.

    This function eagerly loads all component types (skills, commands,
    agents, hooks, MCP, settings) available in the directory.
    """
    manifest = _load_manifest(plugin_dir)
    runtime = ClaudePluginRuntime(manifest=manifest, root=plugin_dir)

    # Skills
    _load_plugin_skills(runtime)

    # Commands
    from .commands import load_plugin_commands

    load_plugin_commands(runtime)

    # Agents
    from .agents import load_plugin_agents

    load_plugin_agents(runtime)

    # Hooks
    from .hooks import load_plugin_hooks

    load_plugin_hooks(runtime)

    # MCP
    from .mcp import load_plugin_mcp

    load_plugin_mcp(runtime)

    # Settings (only `agent` key in v1)
    _load_plugin_settings(runtime)

    return runtime


def _load_manifest(plugin_dir: Path) -> ClaudePluginManifest:
    manifest_path = plugin_dir / ".claude-plugin" / "plugin.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"Missing .claude-plugin/plugin.json in {plugin_dir}"
        )
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    return ClaudePluginManifest.model_validate(raw)


def _load_plugin_skills(runtime: ClaudePluginRuntime) -> None:
    """Discover ``skills/`` subdirectories and register them as namespaced skills."""
    from kaos.path import KaosPath

    from kimi_cli.skill import Skill, parse_skill_text

    skills_dir = runtime.root / "skills"
    if not skills_dir.is_dir():
        return

    plugin_name = runtime.manifest.name
    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.is_file():
            continue
        try:
            content = skill_md.read_text(encoding="utf-8")
            raw_skill = parse_skill_text(
                content,
                dir_path=KaosPath.unsafe_from_local_path(entry),
            )
            namespaced_name = f"{plugin_name}:{raw_skill.name}"
            skill = Skill(
                name=namespaced_name,
                description=raw_skill.description,
                type=raw_skill.type,
                dir=raw_skill.dir,
                flow=raw_skill.flow,
                is_plugin=True,
            )
            runtime.skills[namespaced_name] = skill
        except Exception as exc:
            runtime.warnings.append(
                f"Skipping skill {entry.name}: {exc}"
            )
            logger.warning(
                "Skipping Claude plugin skill {plugin}:{skill}: {error}",
                plugin=plugin_name,
                skill=entry.name,
                error=exc,
            )


def _load_plugin_settings(runtime: ClaudePluginRuntime) -> None:
    """Parse ``settings.json`` and extract the ``agent`` key."""
    settings_path = runtime.root / "settings.json"
    if not settings_path.is_file():
        return

    try:
        settings: dict[str, Any] = json.loads(
            settings_path.read_text(encoding="utf-8")
        )
    except (json.JSONDecodeError, OSError) as exc:
        runtime.warnings.append(f"Invalid settings.json: {exc}")
        logger.warning(
            "Invalid settings.json in plugin '{name}': {error}",
            name=runtime.manifest.name,
            error=exc,
        )
        return

    agent_name = settings.get("agent")
    if agent_name and isinstance(agent_name, str):
        # Resolve the agent file from the plugin's agents/ directory
        agent_file = runtime.root / "agents" / f"{agent_name}.md"
        if agent_file.is_file():
            runtime.default_agent_file = agent_file
            logger.info(
                "Plugin '{plugin}' selects default agent: {agent}",
                plugin=runtime.manifest.name,
                agent=agent_name,
            )
        else:
            runtime.warnings.append(
                f"settings.json references agent '{agent_name}' "
                f"but agents/{agent_name}.md not found"
            )

    # Warn about unsupported settings keys
    _SUPPORTED_SETTINGS_KEYS = {"agent"}
    unsupported = set(settings.keys()) - _SUPPORTED_SETTINGS_KEYS
    if unsupported:
        msg = (
            f"Unsupported settings.json keys in plugin "
            f"'{runtime.manifest.name}': {sorted(unsupported)}"
        )
        runtime.warnings.append(msg)
        logger.warning(msg)


def build_plugin_capability_summary(bundle: ClaudePluginBundle) -> str:
    """Build a concise capability summary for model-visible context.

    Lists each plugin's **skills** (actionable — read the SKILL.md for
    instructions) and **commands** (slash-command only — tell the user
    the invocation form).  Plugin agents are omitted because they are
    not autonomously executable by the model in v1.

    Returns an empty string when no plugin capabilities exist.
    """
    sections: list[str] = []

    for name, plugin_rt in sorted(bundle.plugins.items()):
        lines: list[str] = []

        # Skills: model can read SKILL.md and follow instructions
        for skill_name, skill in sorted(plugin_rt.skills.items()):
            desc = skill.description or "No description"
            lines.append(
                f"- {skill_name} — {desc} "
                f"(read `{skill.skill_md_file}` for instructions)"
            )

        # Commands: slash-command only, model should tell the user
        for cmd_name, cmd in sorted(plugin_rt.commands.items()):
            desc = cmd.description or "No description"
            lines.append(f"- /{cmd_name} — {desc} (slash command only)")

        if lines:
            header = f"### Plugin: {name} (v{plugin_rt.manifest.version})"
            if plugin_rt.manifest.description:
                header += f"\n{plugin_rt.manifest.description}"
            sections.append(header + "\n" + "\n".join(lines))

    if not sections:
        return ""

    return (
        "## Loaded Claude-compatible plugins\n\n"
        "The following plugin capabilities are available. "
        "For skills, read the SKILL.md file to get detailed instructions. "
        "For commands, tell the user the slash-command invocation form.\n\n"
        + "\n\n".join(sections)
    )
