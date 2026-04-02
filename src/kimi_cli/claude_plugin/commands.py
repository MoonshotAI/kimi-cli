"""Parse Claude plugin Markdown commands and register as Kimi slash commands."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from kimi_cli.utils.frontmatter import parse_frontmatter
from kimi_cli.utils.logging import logger

from .spec import ClaudeCommandSpec

if TYPE_CHECKING:
    from .spec import ClaudePluginRuntime

# Frontmatter keys that have no safe Kimi mapping in v1.
_UNSUPPORTED_COMMAND_KEYS = frozenset({
    "allowed-tools",
    "disable-model-invocation",
    "model",
})

_warned_command_keys: set[str] = set()


def load_plugin_commands(runtime: ClaudePluginRuntime) -> None:
    """Parse ``commands/*.md`` and populate *runtime.commands*."""
    commands_dir = runtime.root / "commands"
    if not commands_dir.is_dir():
        return

    plugin_name = runtime.manifest.name
    plugin_root = runtime.root
    for md_file in sorted(commands_dir.iterdir()):
        if md_file.suffix != ".md" or not md_file.is_file():
            continue

        try:
            spec = _parse_command_md(md_file, plugin_name, plugin_root=plugin_root)
        except Exception as exc:
            runtime.warnings.append(f"Skipping command {md_file.name}: {exc}")
            logger.warning(
                "Skipping Claude plugin command {plugin}:{cmd}: {error}",
                plugin=plugin_name,
                cmd=md_file.stem,
                error=exc,
            )
            continue

        _warn_unsupported_frontmatter(spec, plugin_name)
        runtime.commands[spec.full_name] = spec


def _parse_command_md(
    path: Path,
    plugin_name: str,
    *,
    plugin_root: Path | None = None,
) -> ClaudeCommandSpec:
    """Parse a single Markdown command file into a ``ClaudeCommandSpec``."""
    text = path.read_text(encoding="utf-8")
    frontmatter = parse_frontmatter(text) or {}

    # Body is everything after the closing ``---`` of frontmatter.
    body = _extract_body(text)

    command_name = path.stem
    description = frontmatter.get("description", "")

    return ClaudeCommandSpec(
        name=command_name,
        full_name=f"{plugin_name}:{command_name}",
        description=str(description),
        body=body,
        frontmatter=frontmatter,
        plugin_root=plugin_root,
    )


def expand_arguments(body: str, args: str, *, plugin_root: Path | None = None) -> str:
    """Replace ``$ARGUMENTS`` and ``${CLAUDE_PLUGIN_ROOT}`` in the command body."""
    result = body.replace("$ARGUMENTS", args)
    if plugin_root is not None:
        result = result.replace("${CLAUDE_PLUGIN_ROOT}", str(plugin_root))
    return result


def build_frontmatter_context(spec: ClaudeCommandSpec) -> str:
    """Build an advisory instruction block for unsupported frontmatter fields.

    Returns an empty string when there are no advisory fields to surface.
    """
    advisory: list[str] = []
    for key in sorted(spec.frontmatter):
        if key in _UNSUPPORTED_COMMAND_KEYS:
            advisory.append(f"- {key}: {spec.frontmatter[key]}")
    if not advisory:
        return ""
    lines = "\n".join(advisory)
    return (
        "\n\n[Claude plugin command constraints — not enforced by Kimi, "
        "treat as advisory instructions]\n" + lines
    )


def _extract_body(text: str) -> str:
    """Return the text after the frontmatter block, or the full text if none."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text

    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "\n".join(lines[i + 1:]).strip()

    return text


def _warn_unsupported_frontmatter(spec: ClaudeCommandSpec, plugin_name: str) -> None:
    """Emit one warning per unsupported frontmatter key family."""
    for key in spec.frontmatter:
        if key in _UNSUPPORTED_COMMAND_KEYS and key not in _warned_command_keys:
            _warned_command_keys.add(key)
            logger.warning(
                "Unsupported Claude command metadata '{key}' in "
                "plugin '{plugin}' (best-effort, not enforced)",
                key=key,
                plugin=plugin_name,
            )
