from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import pydantic
from jinja2 import Environment as JinjaEnvironment
from jinja2 import FileSystemLoader, StrictUndefined, TemplateError, UndefinedError
from kaos.path import KaosPath
from kosong.tooling import Toolset

from kimi_cli.agentspec import load_agent_spec
from kimi_cli.approval_runtime import ApprovalRuntime
from kimi_cli.auth.oauth import OAuthManager
from kimi_cli.background import BackgroundTaskManager
from kimi_cli.config import Config
from kimi_cli.exception import MCPConfigError, SystemPromptTemplateError
from kimi_cli.llm import LLM
from kimi_cli.notifications import NotificationManager
from kimi_cli.session import Session
from kimi_cli.skill import (
    Skill,
    discover_skills_from_roots,
    format_skills_for_prompt,
    index_skills,
    resolve_skills_roots,
)
from kimi_cli.soul.approval import Approval, ApprovalState
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.subagents.models import AgentTypeDefinition, ToolPolicy
from kimi_cli.subagents.registry import LaborMarket
from kimi_cli.subagents.store import SubagentStore
from kimi_cli.utils.environment import Environment
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import find_project_root, is_within_directory, list_directory
from kimi_cli.wire.root_hub import RootWireHub

if TYPE_CHECKING:
    from fastmcp.mcp_config import MCPConfig


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
    """The merged content of AGENTS.md files (from project root to work_dir)."""
    KIMI_SKILLS: str
    """Formatted information about available skills."""
    KIMI_ADDITIONAL_DIRS_INFO: str
    """Formatted information about additional directories in the workspace."""
    KIMI_OS: str
    """The operating system kind, e.g. 'Windows', 'macOS', 'Linux'."""
    KIMI_SHELL: str
    """The shell executable used by the Shell tool, e.g. 'bash (`/bin/bash`)'."""


_AGENTS_MD_MAX_BYTES = 32 * 1024  # 32 KiB


async def _dirs_root_to_leaf(work_dir: KaosPath, project_root: KaosPath) -> list[KaosPath]:
    """Return the list of directories from *project_root* down to *work_dir* (inclusive)."""
    dirs: list[KaosPath] = []
    current = work_dir
    while True:
        dirs.append(current)
        if current == project_root:
            break
        parent = current.parent
        if parent == current:
            break
        current = parent
    dirs.reverse()  # root → leaf
    return dirs


async def load_agents_md(work_dir: KaosPath) -> str | None:
    """Discover and merge ``AGENTS.md`` files from the project root down to *work_dir*.

    For each directory on the path, the following candidates are checked in order:

    1. ``.kimi/AGENTS.md``  — project-local kimi config (highest priority)
    2. ``AGENTS.md``        — standard location
    3. ``agents.md``        — lowercase variant (mutually exclusive with 2)

    Within a single directory, ``.kimi/AGENTS.md`` and ``AGENTS.md``/``agents.md``
    are **both** loaded (with ``.kimi/`` first), but ``AGENTS.md`` and ``agents.md``
    are mutually exclusive (uppercase wins).

    All discovered files are concatenated root→leaf, separated by ``\\n\\n``, with
    source annotations.  Total size is capped at :data:`_AGENTS_MD_MAX_BYTES`.
    Budget is allocated leaf-first so deeper (more specific) files are never
    truncated in favour of shallower ones.
    """
    project_root = await find_project_root(work_dir)
    dirs = await _dirs_root_to_leaf(work_dir, project_root)

    # Phase 1: collect all candidate files (root → leaf order)
    discovered: list[tuple[KaosPath, str]] = []  # (path, content)
    for d in dirs:
        # .kimi/AGENTS.md is always checked independently (can coexist with root-level file)
        kimi_path = d / ".kimi" / "AGENTS.md"
        # AGENTS.md and agents.md are mutually exclusive (uppercase wins)
        root_candidates = [d / "AGENTS.md", d / "agents.md"]

        candidates: list[KaosPath] = []
        if await kimi_path.is_file():
            candidates.append(kimi_path)
        for rc in root_candidates:
            if await rc.is_file():
                candidates.append(rc)
                break

        for path in candidates:
            content = (await path.read_text()).strip()
            if content:
                discovered.append((path, content))
                logger.info("Loaded agents.md: {path}", path=path)

    if not discovered:
        logger.info(
            "No AGENTS.md found from {root} to {cwd}",
            root=project_root,
            cwd=work_dir,
        )
        return None

    # Phase 2: allocate budget leaf-first so deeper (more specific) files
    # are never truncated in favour of shallower ones.
    # The annotation overhead (<!-- From: ... -->\n and \n\n separators)
    # is included in the budget so the final output never exceeds the limit.
    remaining = _AGENTS_MD_MAX_BYTES
    budgeted: list[tuple[KaosPath, str]] = [None] * len(discovered)  # type: ignore[list-item]
    for i in reversed(range(len(discovered))):
        path, content = discovered[i]
        annotation = f"<!-- From: {path} -->\n"
        # Reserve space for the annotation and the \n\n separator between parts
        separator_cost = len(b"\n\n") if i < len(discovered) - 1 else 0
        overhead = len(annotation.encode()) + separator_cost
        remaining -= overhead
        if remaining <= 0:
            budgeted[i] = (path, "")
            remaining = 0
            continue
        encoded = content.encode()
        if len(encoded) > remaining:
            content = encoded[:remaining].decode(errors="ignore").strip()
            logger.warning("AGENTS.md truncated due to size limit: {path}", path=path)
        remaining -= len(content.encode())
        budgeted[i] = (path, content)

    # Phase 3: assemble in root → leaf order, skipping entries emptied by truncation
    parts: list[str] = []
    for path, content in budgeted:
        if content:
            parts.append(f"<!-- From: {path} -->\n{content}")

    return "\n\n".join(parts) if parts else None


@dataclass(slots=True, kw_only=True)
class Runtime:
    """Agent runtime."""

    config: Config
    oauth: OAuthManager
    llm: LLM | None  # we do not freeze the `Runtime` dataclass because LLM can be changed
    session: Session
    builtin_args: BuiltinSystemPromptArgs
    denwa_renji: DenwaRenji
    approval: Approval
    labor_market: LaborMarket
    environment: Environment
    notifications: NotificationManager
    background_tasks: BackgroundTaskManager
    skills: dict[str, Skill]
    additional_dirs: list[KaosPath]
    skills_dirs: list[KaosPath]
    subagent_store: SubagentStore | None = None
    approval_runtime: ApprovalRuntime | None = None
    root_wire_hub: RootWireHub | None = None
    subagent_id: str | None = None
    subagent_type: str | None = None
    role: Literal["root", "subagent"] = "root"
    hook_engine: Any = None
    """HookEngine instance, set by KimiCLI after soul creation."""

    def __post_init__(self) -> None:
        if self.subagent_store is None:
            self.subagent_store = SubagentStore(self.session)
        if self.root_wire_hub is None:
            self.root_wire_hub = RootWireHub()
        if self.approval_runtime is None:
            self.approval_runtime = ApprovalRuntime()
        self.approval_runtime.bind_root_wire_hub(self.root_wire_hub)
        self.approval.set_runtime(self.approval_runtime)
        self.background_tasks.bind_runtime(self)

    @staticmethod
    async def create(
        config: Config,
        oauth: OAuthManager,
        llm: LLM | None,
        session: Session,
        yolo: bool,
        skills_dirs: list[KaosPath] | None = None,
    ) -> Runtime:
        ls_output, agents_md, environment = await asyncio.gather(
            list_directory(session.work_dir),
            load_agents_md(session.work_dir),
            Environment.detect(),
        )

        # Discover and format skills (grouped by scope for the system prompt).
        scoped_roots = await resolve_skills_roots(
            session.work_dir,
            skills_dirs=skills_dirs,
            merge_brands=config.merge_all_available_skills,
            extra_skill_dirs=config.extra_skill_dirs or None,
        )
        # Canonicalize so symlinked skill directories match resolved paths
        skills_roots_canonical = [s.root.canonical() for s in scoped_roots]
        skills = await discover_skills_from_roots(scoped_roots)
        skills_by_name = index_skills(skills)
        logger.info("Discovered {count} skill(s)", count=len(skills))
        skills_formatted = format_skills_for_prompt(skills)

        # Restore additional directories from session state, pruning stale entries
        additional_dirs: list[KaosPath] = []
        pruned = False
        valid_dir_strs: list[str] = []
        for dir_str in session.state.additional_dirs:
            d = KaosPath(dir_str).canonical()
            if await d.is_dir():
                additional_dirs.append(d)
                valid_dir_strs.append(dir_str)
            else:
                logger.warning(
                    "Additional directory no longer exists, removing from state: {dir}",
                    dir=dir_str,
                )
                pruned = True
        if pruned:
            session.state.additional_dirs = valid_dir_strs
            session.save_state()

        # Format additional dirs info for system prompt
        additional_dirs_info = ""
        if additional_dirs:
            parts: list[str] = []
            for d in additional_dirs:
                try:
                    dir_ls = await list_directory(d)
                except OSError:
                    logger.warning(
                        "Cannot list additional directory, skipping listing: {dir}", dir=d
                    )
                    dir_ls = "[directory not readable]"
                parts.append(f"### `{d}`\n\n```\n{dir_ls}\n```")
            additional_dirs_info = "\n\n".join(parts)

        # Merge CLI flag with persisted session state
        effective_yolo = yolo or session.state.approval.yolo
        saved_actions = set(session.state.approval.auto_approve_actions)

        def _on_approval_change() -> None:
            session.state.approval.yolo = approval_state.yolo
            session.state.approval.auto_approve_actions = set(approval_state.auto_approve_actions)
            session.save_state()

        approval_state = ApprovalState(
            yolo=effective_yolo,
            auto_approve_actions=saved_actions,
            on_change=_on_approval_change,
        )
        notifications = NotificationManager(
            session.context_file.parent / "notifications",
            config.notifications,
        )

        return Runtime(
            config=config,
            oauth=oauth,
            llm=llm,
            session=session,
            builtin_args=BuiltinSystemPromptArgs(
                KIMI_NOW=datetime.now().astimezone().isoformat(),
                KIMI_WORK_DIR=session.work_dir,
                KIMI_WORK_DIR_LS=ls_output,
                KIMI_AGENTS_MD=agents_md or "",
                KIMI_SKILLS=skills_formatted or "No skills found.",
                KIMI_ADDITIONAL_DIRS_INFO=additional_dirs_info,
                KIMI_OS=environment.os_kind,
                KIMI_SHELL=f"{environment.shell_name} (`{environment.shell_path}`)",
            ),
            denwa_renji=DenwaRenji(),
            approval=Approval(state=approval_state),
            labor_market=LaborMarket(),
            environment=environment,
            notifications=notifications,
            background_tasks=BackgroundTaskManager(
                session,
                config.background,
                notifications=notifications,
            ),
            skills=skills_by_name,
            additional_dirs=additional_dirs,
            # Only expose skills roots outside the workspace for Glob access;
            # project-level roots are already within work_dir.
            skills_dirs=[
                r for r in skills_roots_canonical if not is_within_directory(r, session.work_dir)
            ],
            subagent_store=SubagentStore(session),
            approval_runtime=ApprovalRuntime(),
            root_wire_hub=RootWireHub(),
            role="root",
        )

    def copy_for_subagent(
        self,
        *,
        agent_id: str,
        subagent_type: str,
        llm_override: LLM | None = None,
    ) -> Runtime:
        """Clone runtime for a subagent."""
        return Runtime(
            config=self.config,
            oauth=self.oauth,
            llm=llm_override if llm_override is not None else self.llm,
            session=self.session,
            builtin_args=self.builtin_args,
            denwa_renji=DenwaRenji(),  # subagent must have its own DenwaRenji
            approval=self.approval.share(),
            labor_market=self.labor_market,
            environment=self.environment,
            notifications=self.notifications,
            background_tasks=self.background_tasks.copy_for_role("subagent"),
            skills=self.skills,
            # Share the same list reference so /add-dir mutations propagate to all agents
            additional_dirs=self.additional_dirs,
            skills_dirs=self.skills_dirs,
            subagent_store=self.subagent_store,
            approval_runtime=self.approval_runtime,
            root_wire_hub=self.root_wire_hub,
            subagent_id=agent_id,
            subagent_type=subagent_type,
            role="subagent",
        )


@dataclass(frozen=True, slots=True, kw_only=True)
class Agent:
    """The loaded agent."""

    name: str
    system_prompt: str
    toolset: Toolset
    runtime: Runtime
    """Each agent has its own runtime, which should be derived from its main agent."""


async def load_agent(
    agent_file: Path,
    runtime: Runtime,
    *,
    mcp_configs: list[MCPConfig] | list[dict[str, Any]],
    start_mcp_loading: bool = True,
) -> Agent:
    """
    Load agent from specification file.

    Raises:
        FileNotFoundError: When the agent file is not found.
        AgentSpecError(KimiCLIException, ValueError): When the agent specification is invalid.
        SystemPromptTemplateError(KimiCLIException, ValueError): When the system prompt template
            is invalid.
        InvalidToolError(KimiCLIException, ValueError): When any tool cannot be loaded.
        MCPConfigError(KimiCLIException, ValueError): When any MCP configuration is invalid.
        MCPRuntimeError(KimiCLIException, RuntimeError): When any MCP server cannot be connected.
    """
    logger.info("Loading agent: {agent_file}", agent_file=agent_file)
    agent_spec = load_agent_spec(agent_file)

    system_prompt = _load_system_prompt(
        agent_spec.system_prompt_path,
        agent_spec.system_prompt_args,
        runtime.builtin_args,
    )

    # Register built-in subagent types before loading tools because some tools render
    # descriptions from the labor market on initialization.
    for subagent_name, subagent_spec in agent_spec.subagents.items():
        logger.debug(
            "Registering builtin subagent type: {subagent_name}", subagent_name=subagent_name
        )
        builtin_spec = load_agent_spec(subagent_spec.path)
        tool_policy = (
            ToolPolicy(mode="allowlist", tools=tuple(builtin_spec.allowed_tools))
            if builtin_spec.allowed_tools is not None
            else ToolPolicy(mode="inherit")
        )
        runtime.labor_market.add_builtin_type(
            AgentTypeDefinition(
                name=subagent_name,
                description=subagent_spec.description,
                agent_file=subagent_spec.path,
                when_to_use=builtin_spec.when_to_use,
                default_model=builtin_spec.model,
                tool_policy=tool_policy,
            )
        )

    toolset = KimiToolset()
    tool_deps = {
        KimiToolset: toolset,
        Runtime: runtime,
        # TODO: remove all the following dependencies and use Runtime instead
        Config: runtime.config,
        BuiltinSystemPromptArgs: runtime.builtin_args,
        Session: runtime.session,
        DenwaRenji: runtime.denwa_renji,
        Approval: runtime.approval,
        LaborMarket: runtime.labor_market,
        Environment: runtime.environment,
    }
    tools = agent_spec.allowed_tools if agent_spec.allowed_tools is not None else agent_spec.tools
    if agent_spec.exclude_tools:
        logger.debug("Excluding tools: {tools}", tools=agent_spec.exclude_tools)
        tools = [tool for tool in tools if tool not in agent_spec.exclude_tools]
    toolset.load_tools(tools, tool_deps)

    # Load plugin tools
    from kimi_cli.plugin.manager import get_plugins_dir
    from kimi_cli.plugin.tool import load_plugin_tools

    plugin_tools = load_plugin_tools(get_plugins_dir(), runtime.config, approval=runtime.approval)
    for plugin_tool in plugin_tools:
        if toolset.find(plugin_tool.name) is not None:
            logger.warning(
                "Plugin tool '{name}' conflicts with an existing tool, skipping",
                name=plugin_tool.name,
            )
            continue
        toolset.add(plugin_tool)

    if mcp_configs:
        validated_mcp_configs: list[MCPConfig] = []
        if mcp_configs:
            from fastmcp.mcp_config import MCPConfig

            for mcp_config in mcp_configs:
                try:
                    validated_mcp_configs.append(
                        mcp_config
                        if isinstance(mcp_config, MCPConfig)
                        else MCPConfig.model_validate(mcp_config)
                    )
                except pydantic.ValidationError as e:
                    raise MCPConfigError(f"Invalid MCP config: {e}") from e
        if start_mcp_loading:
            await toolset.load_mcp_tools(validated_mcp_configs, runtime, in_background=True)
        else:
            toolset.defer_mcp_tool_loading(validated_mcp_configs, runtime)

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
    env = JinjaEnvironment(
        loader=FileSystemLoader(path.parent),
        keep_trailing_newline=True,
        lstrip_blocks=True,
        trim_blocks=True,
        variable_start_string="${",
        variable_end_string="}",
        undefined=StrictUndefined,
    )
    try:
        template = env.from_string(system_prompt)
        return template.render(asdict(builtin_args), **args)
    except UndefinedError as exc:
        raise SystemPromptTemplateError(f"Missing system prompt arg in {path}: {exc}") from exc
    except TemplateError as exc:
        raise SystemPromptTemplateError(f"Invalid system prompt template: {path}: {exc}") from exc
