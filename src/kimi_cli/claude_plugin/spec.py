"""Pydantic models and dataclasses for Claude plugin compatibility."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from kimi_cli.hooks.config import HookDef
from kimi_cli.skill import Skill

# ---------------------------------------------------------------------------
# Manifest (.claude-plugin/plugin.json)
# ---------------------------------------------------------------------------


class ClaudePluginManifest(BaseModel):
    """Parsed `.claude-plugin/plugin.json`."""

    name: str
    version: str
    description: str = ""


# ---------------------------------------------------------------------------
# Command (commands/*.md)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ClaudeCommandSpec:
    """A single parsed Markdown command from a Claude plugin."""

    name: str
    """Raw command name (file stem)."""
    full_name: str
    """Namespaced name: ``<plugin>:<command>``."""
    description: str
    body: str
    """The Markdown body after frontmatter — used as the command prompt."""
    frontmatter: dict[str, Any]
    """Full frontmatter dict for diagnostics / warning on unsupported keys."""
    plugin_root: Path | None = None
    """Root directory of the owning plugin, for ``${CLAUDE_PLUGIN_ROOT}`` expansion."""


# ---------------------------------------------------------------------------
# Agent (agents/*.md)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ClaudeAgentSpec:
    """A single parsed Markdown agent from a Claude plugin."""

    name: str
    full_name: str
    description: str
    system_prompt: str
    model: str | None = None
    tools: list[str] | None = None
    allowed_tools: list[str] | None = None
    file_path: Path | None = None


# ---------------------------------------------------------------------------
# Per-plugin runtime bundle
# ---------------------------------------------------------------------------


def _dict_str_skill() -> dict[str, Skill]:
    return {}


def _dict_str_cmd() -> dict[str, ClaudeCommandSpec]:
    return {}


def _dict_str_agent() -> dict[str, ClaudeAgentSpec]:
    return {}


def _list_hookdef() -> list[HookDef]:
    return []


def _list_dict() -> list[dict[str, Any]]:
    return []


def _list_str() -> list[str]:
    return []


@dataclass(slots=True)
class ClaudePluginRuntime:
    """All resolved runtime state for a single Claude plugin directory."""

    manifest: ClaudePluginManifest
    root: Path
    skills: dict[str, Skill] = field(default_factory=_dict_str_skill)
    commands: dict[str, ClaudeCommandSpec] = field(default_factory=_dict_str_cmd)
    agents: dict[str, ClaudeAgentSpec] = field(default_factory=_dict_str_agent)
    hooks: list[HookDef] = field(default_factory=_list_hookdef)
    mcp_configs: list[dict[str, Any]] = field(default_factory=_list_dict)
    default_agent_file: Path | None = None
    warnings: list[str] = field(default_factory=_list_str)


# ---------------------------------------------------------------------------
# Bundle of all loaded plugins
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ClaudePluginBundle:
    """All Claude plugins loaded for the current session."""

    plugins: dict[str, ClaudePluginRuntime]
