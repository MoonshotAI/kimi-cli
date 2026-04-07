"""Discover and load local Claude plugin directories."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

from kimi_cli.utils.logging import logger
from kimi_cli.utils.slashcmd import is_valid_slash_command_name

from .spec import (
    ClaudePluginBundle,
    ClaudePluginManifest,
    ClaudePluginRuntime,
)

PLUGIN_SUMMARY_SENTINEL_BEGIN = "<!-- KIMI_PLUGIN_CAPABILITY_SUMMARY_BEGIN -->"
PLUGIN_SUMMARY_SENTINEL_END = "<!-- KIMI_PLUGIN_CAPABILITY_SUMMARY_END -->"


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
    try:
        entries = sorted(base.iterdir())
    except OSError as exc:
        logger.warning(
            "Cannot scan Claude plugin directory {path}: {error}",
            path=base,
            error=exc,
        )
        return []

    for entry in entries:
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
    plugin_dir = plugin_dir.resolve()
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
    try:
        entries = sorted(skills_dir.iterdir())
    except OSError as exc:
        runtime.warnings.append(f"Skipping skills directory: {exc}")
        logger.warning(
            "Skipping Claude plugin skills directory {plugin}:{path}: {error}",
            plugin=plugin_name,
            path=skills_dir,
            error=exc,
        )
        return

    for entry in entries:
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
            if not is_valid_slash_command_name(namespaced_name):
                runtime.warnings.append(
                    f"Skipping skill {entry.name}: invalid slash command name '{namespaced_name}'"
                )
                logger.warning(
                    "Skipping Claude plugin skill {plugin}:{skill}: "
                    "invalid slash command name '{name}'",
                    plugin=plugin_name,
                    skill=entry.name,
                    name=namespaced_name,
                )
                continue
            if namespaced_name in runtime.skills:
                runtime.warnings.append(
                    f"Skipping duplicate skill {namespaced_name} from {entry.name}"
                )
                logger.warning(
                    "Skipping duplicate Claude plugin skill {plugin}:{skill} from {path}",
                    plugin=plugin_name,
                    skill=raw_skill.name,
                    path=entry,
                )
                continue
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
        settings: Any = json.loads(
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

    if not isinstance(settings, dict):
        runtime.warnings.append("settings.json root is not a JSON object")
        return
    settings_dict = cast(dict[str, Any], settings)

    agent_name = settings_dict.get("agent")
    if agent_name and isinstance(agent_name, str):
        # Resolve the agent file from the plugin's agents/ directory
        agents_dir = (runtime.root / "agents").resolve()
        agent_file = (agents_dir / f"{agent_name}.md").resolve()
        if not agent_file.is_relative_to(agents_dir):
            runtime.warnings.append(
                f"settings.json references agent '{agent_name}' "
                "outside plugin agents/ directory"
            )
            logger.warning(
                "Plugin '{plugin}' settings.json references agent outside agents/ dir: {agent}",
                plugin=runtime.manifest.name,
                agent=agent_name,
            )
            agent_file = None

        if agent_file is not None and agent_file.is_file():
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
    unsupported = set(settings_dict.keys()) - _SUPPORTED_SETTINGS_KEYS
    if unsupported:
        msg = (
            f"Unsupported settings.json keys in plugin "
            f"'{runtime.manifest.name}': {sorted(unsupported)}"
        )
        runtime.warnings.append(msg)
        logger.warning(msg)


def _effective_summary_command_names(
    bundle: ClaudePluginBundle,
    *,
    reserved_names: set[str] | None = None,
) -> set[str]:
    """Return plugin command names that will actually be reachable in v1 summary."""
    seen = set(reserved_names or ())
    if reserved_names is None:
        for plugin_rt in bundle.plugins.values():
            for skill in plugin_rt.skills.values():
                if skill.is_plugin and skill.type in ("standard", "flow"):
                    seen.add(skill.name)

    available: set[str] = set()
    for plugin_rt in bundle.plugins.values():
        for cmd_name in plugin_rt.commands:
            if cmd_name in seen:
                continue
            available.add(cmd_name)
            seen.add(cmd_name)

    return available


def build_plugin_capability_summary(
    bundle: ClaudePluginBundle,
    *,
    reserved_command_names: set[str] | None = None,
    registered_plugin_skill_names: set[str] | None = None,
) -> str:
    """Build a concise capability summary for model-visible context.

    Lists each plugin's **skills** (actionable — read the SKILL.md for
    instructions) and **commands** (slash-command only — tell the user
    the invocation form).  Plugin agents are omitted because they are
    not autonomously executable by the model in v1.

    Returns an empty string when no plugin capabilities exist.
    """
    sections: list[str] = []
    summary_command_names = _effective_summary_command_names(
        bundle,
        reserved_names=reserved_command_names,
    )

    for name, plugin_rt in sorted(bundle.plugins.items()):
        lines: list[str] = []

        # Skills: model can read SKILL.md and follow instructions
        for skill_name, skill in sorted(plugin_rt.skills.items()):
            if (
                registered_plugin_skill_names is not None
                and skill.name not in registered_plugin_skill_names
            ):
                continue
            desc = skill.description or "No description"
            lines.append(
                f"- {skill_name} — {desc} "
                f"(read `{skill.skill_md_file}` for instructions)"
            )

        # Commands: slash-command only, model should tell the user
        for cmd_name, cmd in sorted(plugin_rt.commands.items()):
            if cmd_name not in summary_command_names:
                continue
            desc = cmd.description or "No description"
            lines.append(f"- /{cmd_name} — {desc} (slash command only)")

        if lines:
            header = f"### Plugin: {name} (v{plugin_rt.manifest.version})"
            if plugin_rt.manifest.description:
                header += f"\n{plugin_rt.manifest.description}"
            sections.append(header + "\n" + "\n".join(lines))

    if not sections:
        return ""

    body = (
        "## Loaded Claude-compatible plugins\n\n"
        "The following plugin capabilities are available. "
        "For skills, read the SKILL.md file to get detailed instructions. "
        "For commands, tell the user the slash-command invocation form.\n\n"
        + "\n\n".join(sections)
    )
    return (
        PLUGIN_SUMMARY_SENTINEL_BEGIN + "\n"
        + body + "\n"
        + PLUGIN_SUMMARY_SENTINEL_END
    )
