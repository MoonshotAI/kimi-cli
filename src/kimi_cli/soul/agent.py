from __future__ import annotations

import asyncio
import importlib
import inspect
import string
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from kaos.path import KaosPath
from kosong.tooling import Toolset

from kimi_cli.agentspec import load_agent_spec
from kimi_cli.config import Config
from kimi_cli.llm import LLM
from kimi_cli.session import Session
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.injector import Injector, ToolDependencyError, ToolLoadError, ToolLoadIssue
from kimi_cli.soul.toolset import KimiToolset, ToolType
from kimi_cli.tools import SkipThisTool
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import list_directory


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

    @staticmethod
    async def create(
        config: Config,
        llm: LLM | None,
        session: Session,
        yolo: bool,
    ) -> Runtime:
        ls_output, agents_md = await asyncio.gather(
            list_directory(session.work_dir),
            load_agents_md(session.work_dir),
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
    mcp_configs: list[dict[str, Any]],
) -> Agent:
    """
    Load agent from specification file.

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
            mcp_configs=mcp_configs,
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
    }
    tools = agent_spec.tools
    if agent_spec.exclude_tools:
        logger.debug("Excluding tools: {tools}", tools=agent_spec.exclude_tools)
        tools = [tool for tool in tools if tool not in agent_spec.exclude_tools]
    issues = _load_tools(toolset, tools, tool_deps)
    if issues:
        details = "\n".join(f"- {issue.path}: {issue.reason}" for issue in issues)
        raise ValueError(f"Invalid tools:\n{details}")

    if mcp_configs:
        await _load_mcp_tools(toolset, mcp_configs, runtime)

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
) -> list[ToolLoadIssue]:
    injector = Injector(dependencies)
    issues: list[ToolLoadIssue] = []
    for tool_path in tool_paths:
        try:
            tool = _load_tool(tool_path, injector)
        except SkipThisTool:
            logger.info("Skipping tool: {tool_path}", tool_path=tool_path)
            continue
        except (ToolDependencyError, ToolLoadError) as e:
            logger.error("{error}", error=e)
            issues.append(ToolLoadIssue(tool_path, str(e)))
            continue
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("Unexpected error when loading tool: {tool_path}", tool_path=tool_path)
            issues.append(ToolLoadIssue(tool_path, f"Unexpected error: {e}"))
            continue
        if tool:
            toolset.add(tool)
        else:
            issues.append(ToolLoadIssue(tool_path, "Import failed or class missing"))
    logger.info("Loaded tools: {tools}", tools=[tool.name for tool in toolset.tools])
    if issues:
        logger.error("Tool load issues: {issues}", issues=[f"{i.path}: {i.reason}" for i in issues])
    return issues


def _load_tool(tool_path: str, injector: Injector) -> ToolType | None:
    logger.debug("Loading tool: {tool_path}", tool_path=tool_path)
    module_name, class_name = tool_path.rsplit(":", 1)
    try:
        module = importlib.import_module(module_name)
    except ImportError as e:
        raise ToolLoadError(tool_path, f"Import failed: {e}") from e
    cls = getattr(module, class_name, None)
    if cls is None:
        raise ToolLoadError(tool_path, "Tool class not found in module")
    args: list[Any] = []
    deps_attr = getattr(cls, "__dependencies__", None)
    if deps_attr is not None:
        if not isinstance(deps_attr, (list, tuple)):
            raise ToolLoadError(tool_path, "__dependencies__ must be a list or tuple of types")
        dependencies_list = cast(list[type[Any]] | tuple[type[Any], ...], deps_attr)
        for dep in dependencies_list:
            args.append(injector.require(dep, tool_path=tool_path))
    elif "__init__" in cls.__dict__:
        # the tool class overrides the `__init__` of base class
        for param in inspect.signature(cls).parameters.values():
            if param.kind == inspect.Parameter.KEYWORD_ONLY:
                # once we encounter a keyword-only parameter, we stop injecting dependencies
                break
            if param.annotation is inspect.Signature.empty:
                raise ToolLoadError(
                    tool_path, f"Missing type annotation for dependency param '{param.name}'"
                )
            args.append(injector.require(param.annotation, tool_path=tool_path))
    return cls(*args)


async def _load_mcp_tools(
    toolset: KimiToolset,
    mcp_configs: list[dict[str, Any]],
    runtime: Runtime,
):
    """
    Raises:
        ValueError: If the MCP config is not valid.
        RuntimeError: If the MCP server cannot be connected.
    """
    import fastmcp

    from kimi_cli.tools.mcp import MCPTool

    for mcp_config in mcp_configs:
        logger.info("Loading MCP tools from: {mcp_config}", mcp_config=mcp_config)
        client = fastmcp.Client(mcp_config)
        async with client:
            for tool in await client.list_tools():
                toolset.add(MCPTool(tool, client, runtime=runtime))
    return toolset
