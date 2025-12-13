from __future__ import annotations

import asyncio
import importlib
import inspect
import string
from collections.abc import Mapping
from contextlib import AsyncExitStack
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from kaos.path import KaosPath
from kosong.tooling import Toolset

from kimi_cli.agentspec import load_agent_spec
from kimi_cli.config import Config
from kimi_cli.llm import LLM
from kimi_cli.session import Session
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.toolset import KimiToolset, ToolType
from kimi_cli.tools import SkipThisTool
from kimi_cli.utils.environment import Environment
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import list_directory


class MCPClientManager:
    """Manages MCP client connections lifecycle."""

    def __init__(self) -> None:
        self._exit_stack: AsyncExitStack | None = None
        self._clients: list[Any] = []

    async def connect(
        self, mcp_configs: list[dict[str, Any]], session_id: str | None = None
    ) -> list[Any]:
        """Connect to all MCP servers and return the connected clients.

        Args:
            mcp_configs: List of MCP server configurations.
            session_id: Session ID to set as mcp-session-id header on HTTP transports.

        Returns:
            List of connected MCP clients.

        Raises:
            RuntimeError: If any MCP server fails to connect.
        """
        if not mcp_configs:
            return []

        import fastmcp

        self._exit_stack = AsyncExitStack()
        await self._exit_stack.__aenter__()

        try:
            for mcp_config in mcp_configs:
                logger.info("Connecting to MCP server: {mcp_config}", mcp_config=mcp_config)
                client = fastmcp.Client(mcp_config)
                if session_id:
                    _set_mcp_session_id(client, session_id)
                await self._exit_stack.enter_async_context(client)
                self._clients.append(client)
        except Exception:
            await self.close()
            raise

        return self._clients

    async def close(self) -> None:
        """Close all MCP client connections."""
        if self._exit_stack is not None:
            await self._exit_stack.aclose()
            self._exit_stack = None
            self._clients.clear()


@dataclass(frozen=True, slots=True, kw_only=True)
class BuiltinSystemPromptArgs:
    """Builtin system prompt arguments."""

    KIMI_NOW: str
    """The current datetime."""
    KIMI_WORK_DIR: KaosPath
    """The absolute path of current working directory."""
    KIMI_WORK_DIR_LS: str
    """The directory listing of current working directory."""
    KIMI_AGENTS_MD: str  # TODO: move to first message from system prompt
    """The content of AGENTS.md."""


async def load_agents_md(work_dir: KaosPath) -> str | None:
    paths = [
        work_dir / "AGENTS.md",
        work_dir / "agents.md",
    ]
    for path in paths:
        if await path.is_file():
            logger.info("Loaded agents.md: {path}", path=path)
            return (await path.read_text()).strip()
    logger.info("No AGENTS.md found in {work_dir}", work_dir=work_dir)
    return None


@dataclass(frozen=True, slots=True, kw_only=True)
class Runtime:
    """Agent runtime."""

    config: Config
    llm: LLM | None
    session: Session
    builtin_args: BuiltinSystemPromptArgs
    denwa_renji: DenwaRenji
    approval: Approval
    labor_market: LaborMarket
    environment: Environment

    @staticmethod
    async def create(
        config: Config,
        llm: LLM | None,
        session: Session,
        yolo: bool,
    ) -> Runtime:
        ls_output, agents_md, environment = await asyncio.gather(
            list_directory(session.work_dir),
            load_agents_md(session.work_dir),
            Environment.detect(),
        )

        return Runtime(
            config=config,
            llm=llm,
            session=session,
            builtin_args=BuiltinSystemPromptArgs(
                KIMI_NOW=datetime.now().astimezone().isoformat(),
                KIMI_WORK_DIR=session.work_dir,
                KIMI_WORK_DIR_LS=ls_output,
                KIMI_AGENTS_MD=agents_md or "",
            ),
            denwa_renji=DenwaRenji(),
            approval=Approval(yolo=yolo),
            labor_market=LaborMarket(),
            environment=environment,
        )

    def copy_for_fixed_subagent(self) -> Runtime:
        """Clone runtime for fixed subagent."""
        return Runtime(
            config=self.config,
            llm=self.llm,
            session=self.session,
            builtin_args=self.builtin_args,
            denwa_renji=DenwaRenji(),  # subagent must have its own DenwaRenji
            approval=self.approval,
            labor_market=LaborMarket(),  # fixed subagent has its own LaborMarket
            environment=self.environment,
        )

    def copy_for_dynamic_subagent(self) -> Runtime:
        """Clone runtime for dynamic subagent."""
        return Runtime(
            config=self.config,
            llm=self.llm,
            session=self.session,
            builtin_args=self.builtin_args,
            denwa_renji=DenwaRenji(),  # subagent must have its own DenwaRenji
            approval=self.approval,
            labor_market=self.labor_market,  # dynamic subagent shares LaborMarket with main agent
            environment=self.environment,
        )


@dataclass(frozen=True, slots=True, kw_only=True)
class Agent:
    """The loaded agent."""

    name: str
    system_prompt: str
    toolset: Toolset
    runtime: Runtime
    """Each agent has its own runtime, which should be derived from its main agent."""


class LaborMarket:
    def __init__(self):
        self.fixed_subagents: dict[str, Agent] = {}
        self.fixed_subagent_descs: dict[str, str] = {}
        self.dynamic_subagents: dict[str, Agent] = {}

    @property
    def subagents(self) -> Mapping[str, Agent]:
        """Get all subagents in the labor market."""
        return {**self.fixed_subagents, **self.dynamic_subagents}

    def add_fixed_subagent(self, name: str, agent: Agent, description: str):
        """Add a fixed subagent."""
        self.fixed_subagents[name] = agent
        self.fixed_subagent_descs[name] = description

    def add_dynamic_subagent(self, name: str, agent: Agent):
        """Add a dynamic subagent."""
        self.dynamic_subagents[name] = agent


async def load_agent(
    agent_file: Path,
    runtime: Runtime,
    *,
    mcp_clients: list[Any] | None = None,
) -> Agent:
    """
    Load agent from specification file.

    Args:
        agent_file: Path to the agent specification file.
        runtime: The agent runtime.
        mcp_clients: List of already-connected MCP clients from MCPClientManager.

    Raises:
        FileNotFoundError: If the agent spec file does not exist.
        AgentSpecError: If the agent spec is not valid.
    """
    logger.info("Loading agent: {agent_file}", agent_file=agent_file)
    agent_spec = load_agent_spec(agent_file)

    system_prompt = _load_system_prompt(
        agent_spec.system_prompt_path,
        agent_spec.system_prompt_args,
        runtime.builtin_args,
    )

    # load subagents before loading tools because Task tool depends on LaborMarket on initialization
    for subagent_name, subagent_spec in agent_spec.subagents.items():
        logger.debug("Loading subagent: {subagent_name}", subagent_name=subagent_name)
        subagent = await load_agent(
            subagent_spec.path,
            runtime.copy_for_fixed_subagent(),
            mcp_clients=mcp_clients,
        )
        runtime.labor_market.add_fixed_subagent(subagent_name, subagent, subagent_spec.description)

    toolset = KimiToolset()
    tool_deps = {
        KimiToolset: toolset,
        Runtime: runtime,
        Config: runtime.config,
        BuiltinSystemPromptArgs: runtime.builtin_args,
        Session: runtime.session,
        DenwaRenji: runtime.denwa_renji,
        Approval: runtime.approval,
        LaborMarket: runtime.labor_market,
        Environment: runtime.environment,
    }
    tools = agent_spec.tools
    if agent_spec.exclude_tools:
        logger.debug("Excluding tools: {tools}", tools=agent_spec.exclude_tools)
        tools = [tool for tool in tools if tool not in agent_spec.exclude_tools]
    bad_tools = _load_tools(toolset, tools, tool_deps)
    if bad_tools:
        raise ValueError(f"Invalid tools: {bad_tools}")

    if mcp_clients:
        await _load_mcp_tools(toolset, mcp_clients, runtime)

    return Agent(
        name=agent_spec.name,
        system_prompt=system_prompt,
        toolset=toolset,
        runtime=runtime,
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
    return string.Template(system_prompt).substitute(asdict(builtin_args), **args)


# TODO: maybe move to `KimiToolset`
def _load_tools(
    toolset: KimiToolset,
    tool_paths: list[str],
    dependencies: dict[type[Any], Any],
) -> list[str]:
    bad_tools: list[str] = []
    for tool_path in tool_paths:
        try:
            tool = _load_tool(tool_path, dependencies)
        except SkipThisTool:
            logger.info("Skipping tool: {tool_path}", tool_path=tool_path)
            continue
        if tool:
            toolset.add(tool)
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
    if "__init__" in cls.__dict__:
        # the tool class overrides the `__init__` of base class
        for param in inspect.signature(cls).parameters.values():
            if param.kind == inspect.Parameter.KEYWORD_ONLY:
                # once we encounter a keyword-only parameter, we stop injecting dependencies
                break
            # all positional parameters should be dependencies to be injected
            if param.annotation not in dependencies:
                raise ValueError(f"Tool dependency not found: {param.annotation}")
            args.append(dependencies[param.annotation])
    return cls(*args)


async def connect_mcp_clients(
    mcp_configs: list[dict[str, Any]],
    session_id: str | None = None,
) -> list[Any]:
    """Connect to MCP servers and return connected clients.

    Args:
        mcp_configs: List of MCP server configurations.
        session_id: Session ID to set as mcp-session-id header on HTTP transports.

    Returns:
        List of connected MCP clients. Caller is responsible for closing them
        via close_mcp_clients().
    """
    if not mcp_configs:
        return []

    import fastmcp

    clients: list[Any] = []
    try:
        for mcp_config in mcp_configs:
            # Skip empty MCP configs (no servers defined)
            if not mcp_config.get("mcpServers"):
                logger.debug("Skipping empty MCP config: {mcp_config}", mcp_config=mcp_config)
                continue

            logger.info("Connecting to MCP server: {mcp_config}", mcp_config=mcp_config)
            client = fastmcp.Client(mcp_config)
            if session_id:
                _set_mcp_session_id(client, session_id)
            await client.__aenter__()
            clients.append(client)
    except Exception:
        await close_mcp_clients(clients)
        raise
    return clients


async def close_mcp_clients(clients: list[Any]) -> None:
    """Close all MCP client connections."""
    for client in clients:
        try:
            await client.close()
        except Exception as e:
            logger.warning("Failed to close MCP client: {error}", error=e)


async def _load_mcp_tools(
    toolset: KimiToolset,
    mcp_clients: list[Any],
    runtime: Runtime,
) -> None:
    """Load MCP tools from already-connected clients."""
    from kimi_cli.tools.mcp import MCPTool

    for client in mcp_clients:
        tools = await client.list_tools()
        logger.info("Loading {count} MCP tools from connected client", count=len(tools))
        for tool in tools:
            toolset.add(MCPTool(tool, client, runtime=runtime))


def _set_mcp_session_id(client: Any, session_id: str) -> None:
    """Set mcp-session-id header on the client's transport if supported.

    Note: This accesses fastmcp internal transport structure and may break
    on version updates. Stdio transports don't have headers and are skipped.
    """
    try:
        transport = client.transport
        if hasattr(transport, "_underlying_transports"):
            for t in transport._underlying_transports:
                if hasattr(t, "headers"):
                    t.headers["mcp-session-id"] = session_id
        elif hasattr(transport, "transport") and transport.transport is not None:
            inner = transport.transport
            if hasattr(inner, "headers"):
                inner.headers["mcp-session-id"] = session_id
        elif hasattr(transport, "headers"):
            transport.headers["mcp-session-id"] = session_id
    except AttributeError:
        logger.debug("Could not set mcp-session-id: transport structure not recognized")
