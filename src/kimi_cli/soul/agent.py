import importlib
import inspect
import string
from pathlib import Path
from typing import Any, NamedTuple

import fastmcp
from kosong.tooling import CallableTool, CallableTool2, Toolset

from kimi_cli.agentspec import ResolvedAgentSpec, load_agent_spec
from kimi_cli.config import Config
from kimi_cli.metadata import Session
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.globals import AgentGlobals, BuiltinSystemPromptArgs
from kimi_cli.soul.toolset import CustomToolset
from kimi_cli.tools.mcp import MCPTool
from kimi_cli.utils.logging import logger


class Agent(NamedTuple):
    """The loaded agent."""

    name: str
    system_prompt: str
    toolset: Toolset


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
    agent_spec = load_agent_spec(agent_file)

    system_prompt = _load_system_prompt(
        agent_spec.system_prompt_path,
        agent_spec.system_prompt_args,
        globals_.builtin_args,
    )

    tool_deps = {
        ResolvedAgentSpec: agent_spec,
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


type ToolType = CallableTool | CallableTool2[Any]
# TODO: move this to kosong.tooling.simple


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
    args: list[type[Any]] = []
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
