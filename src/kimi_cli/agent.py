import importlib
import inspect
import string
from pathlib import Path
from typing import Any, NamedTuple

import fastmcp
import yaml
from kosong.tooling import Toolset
from kosong.tooling.simple import ToolType
from pydantic import BaseModel, Field

from kimi_cli.config import Config
from kimi_cli.metadata import Session
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.globals import AgentGlobals, BuiltinSystemPromptArgs
from kimi_cli.soul.toolset import CustomToolset
from kimi_cli.tools.mcp import MCPTool
from kimi_cli.utils.logging import logger


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
    subagents: dict[str, "SubagentSpec"] | None = Field(default=None, description="Subagents")


class SubagentSpec(BaseModel):
    """Subagent specification."""

    path: Path = Field(description="Subagent file path")
    description: str = Field(description="Subagent description")


class Agent(NamedTuple):
    """The loaded agent."""

    name: str
    system_prompt: str
    toolset: Toolset


def get_agents_dir() -> Path:
    return Path(__file__).parent / "agents"


DEFAULT_AGENT_FILE = get_agents_dir() / "koder" / "agent.yaml"


async def load_agent_with_mcp(
    agent_file: Path,
    globals_: AgentGlobals,
    mcp_configs: list[dict[str, Any]],
) -> Agent:
    agent = load_agent(agent_file, globals_)
    assert isinstance(agent.toolset, CustomToolset)
    if mcp_configs:
        await _load_mcp_tools(agent.toolset, mcp_configs)
    return agent


def load_agent(
    agent_file: Path,
    globals_: AgentGlobals,
) -> Agent:
    """
    Load agent from specification file.

    Raises:
        ValueError: If the agent spec is not valid.
    """
    logger.info("Loading agent: {agent_file}", agent_file=agent_file)
    agent_spec = _load_agent_spec(agent_file)
    assert agent_spec.extend is None, "agent extension should be recursively resolved"
    if agent_spec.name is None:
        raise ValueError("Agent name is required")
    if agent_spec.system_prompt_path is None:
        raise ValueError("System prompt path is required")
    if agent_spec.tools is None:
        raise ValueError("Tools are required")

    system_prompt = _load_system_prompt(
        agent_spec.system_prompt_path,
        agent_spec.system_prompt_args,
        globals_.builtin_args,
    )

    tool_deps = {
        AgentSpec: agent_spec,
        AgentGlobals: globals_,
        Config: globals_.config,
        BuiltinSystemPromptArgs: globals_.builtin_args,
        Session: globals_.session,
        DenwaRenji: globals_.denwa_renji,
        Approval: globals_.approval,
    }
    tools = agent_spec.tools
    if agent_spec.exclude_tools:
        logger.debug("Excluding tools: {tools}", tools=agent_spec.exclude_tools)
        tools = [tool for tool in tools if tool not in agent_spec.exclude_tools]
    toolset = CustomToolset()
    bad_tools = _load_tools(toolset, tools, tool_deps)
    if bad_tools:
        raise ValueError(f"Invalid tools: {bad_tools}")

    return Agent(
        name=agent_spec.name,
        system_prompt=system_prompt,
        toolset=toolset,
    )


def _load_agent_spec(agent_file: Path) -> AgentSpec:
    assert agent_file.is_file(), "expect agent file to exist"
    with open(agent_file, encoding="utf-8") as f:
        data: dict[str, Any] = yaml.safe_load(f)

    version = data.get("version", 1)
    if version != 1:
        raise ValueError(f"Unsupported agent spec version: {version}")

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
            base_agent_spec.system_prompt_args[k] = v
        if agent_spec.tools is not None:
            base_agent_spec.tools = agent_spec.tools
        if agent_spec.exclude_tools is not None:
            base_agent_spec.exclude_tools = agent_spec.exclude_tools
        if agent_spec.subagents is not None:
            base_agent_spec.subagents = agent_spec.subagents
        agent_spec = base_agent_spec
    return agent_spec


def _load_system_prompt(
    path: Path, args: dict[str, str], builtin_args: BuiltinSystemPromptArgs
) -> str:
    logger.info("Loading system prompt: {path}", path=path)
    system_prompt = path.read_text(encoding="utf-8").strip()
    logger.debug(
        "Substituting system prompt with builtin args: {builtin_args}, spec args: {spec_args}",
        builtin_args=builtin_args,
        spec_args=args,
    )
    return string.Template(system_prompt).substitute(builtin_args._asdict(), **args)


def _load_tools(
    toolset: CustomToolset,
    tool_paths: list[str],
    dependencies: dict[type[Any], Any],
) -> list[str]:
    bad_tools: list[str] = []
    for tool_path in tool_paths:
        tool = _load_tool(tool_path, dependencies)
        if tool:
            toolset += tool
        else:
            bad_tools.append(tool_path)
    logger.info("Loaded tools: {tools}", tools=[tool.name for tool in toolset.tools])
    if bad_tools:
        logger.error("Bad tools: {bad_tools}", bad_tools=bad_tools)
    return bad_tools


def _load_tool(tool_path: str, dependencies: dict[type[Any], Any]) -> ToolType | None:
    logger.debug("Loading tool: {tool_path}", tool_path=tool_path)
    module_name, class_name = tool_path.rsplit(":", 1)
    try:
        module = importlib.import_module(module_name)
    except ImportError:
        return None
    cls = getattr(module, class_name, None)
    if cls is None:
        return None
    args = []
    for param in inspect.signature(cls).parameters.values():
        if param.kind == inspect.Parameter.KEYWORD_ONLY:
            # once we encounter a keyword-only parameter, we stop injecting dependencies
            break
        # all positional parameters should be dependencies to be injected
        if param.annotation not in dependencies:
            raise ValueError(f"Tool dependency not found: {param.annotation}")
        args.append(dependencies[param.annotation])
    return cls(*args)


async def _load_mcp_tools(
    toolset: CustomToolset,
    mcp_configs: list[dict[str, Any]],
):
    """
    Raises:
        ValueError: If the MCP config is not valid.
        RuntimeError: If the MCP server cannot be connected.
    """
    for mcp_config in mcp_configs:
        logger.info("Loading MCP tools from: {mcp_config}", mcp_config=mcp_config)
        client = fastmcp.Client(mcp_config)
        async with client:
            for tool in await client.list_tools():
                toolset += MCPTool(tool, client)
    return toolset
