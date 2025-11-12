from __future__ import annotations

from pathlib import Path
from typing import Any, NamedTuple

import yaml
from pydantic import BaseModel, Field

from kimi_cli.exception import AgentSpecError


def get_agents_dir() -> Path:
    return Path(__file__).parent / "agents"


DEFAULT_AGENT_FILE = get_agents_dir() / "default" / "agent.yaml"


class AgentSpec(BaseModel):
    """Agent specification."""

    extend: str | None = Field(default=None, description="Agent file to extend")
    name: str | None = Field(default=None, description="Agent name")  # required
    system_prompt_path: Path | None = Field(
        default=None, description="System prompt path"
    )  # required
    system_prompt_args: dict[str, str] = Field(
        default_factory=dict, description="System prompt arguments"
    )
    tools: list[str] | None = Field(default=None, description="Tools")  # required
    exclude_tools: list[str] | None = Field(default=None, description="Tools to exclude")
    subagents: dict[str, SubagentSpec] | None = Field(default=None, description="Subagents")


class SubagentSpec(BaseModel):
    """Subagent specification."""

    path: Path = Field(description="Subagent file path")
    description: str = Field(description="Subagent description")


class ResolvedAgentSpec(NamedTuple):
    """Resolved agent specification."""

    name: str
    system_prompt_path: Path
    system_prompt_args: dict[str, str]
    tools: list[str]
    exclude_tools: list[str]
    subagents: dict[str, SubagentSpec]


def load_agent_spec(agent_file: Path) -> ResolvedAgentSpec:
    """
    Load agent specification from file.

    Raises:
        FileNotFoundError: If the agent spec file is not found.
        AgentSpecError: If the agent spec is not valid.
    """
    agent_spec = _load_agent_spec(agent_file)
    assert agent_spec.extend is None, "agent extension should be recursively resolved"
    if agent_spec.name is None:
        raise AgentSpecError("Agent name is required")
    if agent_spec.system_prompt_path is None:
        raise AgentSpecError("System prompt path is required")
    if agent_spec.tools is None:
        raise AgentSpecError("Tools are required")
    return ResolvedAgentSpec(
        name=agent_spec.name,
        system_prompt_path=agent_spec.system_prompt_path,
        system_prompt_args=agent_spec.system_prompt_args,
        tools=agent_spec.tools,
        exclude_tools=agent_spec.exclude_tools or [],
        subagents=agent_spec.subagents or {},
    )


def _load_agent_spec(agent_file: Path) -> AgentSpec:
    assert agent_file.is_file(), "expect agent file to exist"
    try:
        with open(agent_file, encoding="utf-8") as f:
            data: dict[str, Any] = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise AgentSpecError(f"Invalid YAML in agent spec file: {e}") from e

    version = data.get("version", 1)
    if version != 1:
        raise AgentSpecError(f"Unsupported agent spec version: {version}")

    agent_spec = AgentSpec(**data.get("agent", {}))
    if agent_spec.system_prompt_path is not None:
        agent_spec.system_prompt_path = agent_file.parent / agent_spec.system_prompt_path
    if agent_spec.subagents is not None:
        for v in agent_spec.subagents.values():
            v.path = agent_file.parent / v.path
    if agent_spec.extend:
        if agent_spec.extend == "default":
            base_agent_file = DEFAULT_AGENT_FILE
        else:
            base_agent_file = agent_file.parent / agent_spec.extend
        base_agent_spec = _load_agent_spec(base_agent_file)
        if agent_spec.name is not None:
            base_agent_spec.name = agent_spec.name
        if agent_spec.system_prompt_path is not None:
            base_agent_spec.system_prompt_path = agent_spec.system_prompt_path
        for k, v in agent_spec.system_prompt_args.items():
            # system prompt args should be merged instead of overwritten
            base_agent_spec.system_prompt_args[k] = v
        if agent_spec.tools is not None:
            base_agent_spec.tools = agent_spec.tools
        if agent_spec.exclude_tools is not None:
            base_agent_spec.exclude_tools = agent_spec.exclude_tools
        if agent_spec.subagents is not None:
            base_agent_spec.subagents = agent_spec.subagents
        agent_spec = base_agent_spec
    return agent_spec
