"""Parse Claude plugin Markdown agents."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from kimi_cli.utils.frontmatter import parse_frontmatter
from kimi_cli.utils.logging import logger

from .spec import ClaudeAgentSpec

if TYPE_CHECKING:
    from .spec import ClaudePluginRuntime


def load_plugin_agents(runtime: ClaudePluginRuntime) -> None:
    """Parse ``agents/*.md`` and populate *runtime.agents*."""
    agents_dir = runtime.root / "agents"
    if not agents_dir.is_dir():
        return

    plugin_name = runtime.manifest.name
    try:
        entries = sorted(agents_dir.iterdir())
    except OSError as exc:
        runtime.warnings.append(f"Skipping agents directory: {exc}")
        logger.warning(
            "Skipping Claude plugin agents directory {plugin}:{path}: {error}",
            plugin=plugin_name,
            path=agents_dir,
            error=exc,
        )
        return

    for md_file in entries:
        if md_file.suffix != ".md" or not md_file.is_file():
            continue

        try:
            spec = parse_agent_md(md_file, plugin_name)
        except Exception as exc:
            runtime.warnings.append(f"Skipping agent {md_file.name}: {exc}")
            logger.warning(
                "Skipping Claude plugin agent {plugin}:{agent}: {error}",
                plugin=plugin_name,
                agent=md_file.stem,
                error=exc,
            )
            continue

        runtime.agents[spec.full_name] = spec


def parse_agent_md(path: Path, plugin_name: str) -> ClaudeAgentSpec:
    """Parse a single Markdown agent file into a ``ClaudeAgentSpec``."""
    text = path.read_text(encoding="utf-8")
    frontmatter = parse_frontmatter(text) or {}

    body = _extract_body(text)
    agent_name = frontmatter.get("name", path.stem)
    full_name = f"{plugin_name}:{agent_name}"
    allowed_tools = (
        frontmatter.get("allowed-tools")
        if "allowed-tools" in frontmatter
        else frontmatter.get("allowed_tools")
    )

    return ClaudeAgentSpec(
        name=agent_name,
        full_name=full_name,
        description=frontmatter.get("description", ""),
        system_prompt=body,
        model=frontmatter.get("model"),
        tools=frontmatter.get("tools"),
        allowed_tools=allowed_tools,
        file_path=path,
    )


def _extract_body(text: str) -> str:
    """Return the text after the frontmatter block."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text

    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "\n".join(lines[i + 1:]).strip()

    return text
