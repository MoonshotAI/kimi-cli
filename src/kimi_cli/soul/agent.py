from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pydantic
from jinja2 import Environment as JinjaEnvironment
from jinja2 import StrictUndefined, TemplateError, UndefinedError
from kaos.path import KaosPath
from kosong.tooling import Toolset

from kimi_cli.agentspec import load_agent_spec
from kimi_cli.auth.oauth import OAuthManager
from kimi_cli.config import Config
from kimi_cli.exception import MCPConfigError, SystemPromptTemplateError
from kimi_cli.llm import LLM
from kimi_cli.session import Session
from kimi_cli.hooks import HookManager
from kimi_cli.hooks.config import HooksConfig
from kimi_cli.skill import Skill, discover_skills_from_roots, index_skills, resolve_skills_roots
from kimi_cli.soul.approval import Approval, ApprovalState
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.utils.environment import Environment
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import list_directory

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
    """The content of AGENTS.md."""
    KIMI_SKILLS: str
    """Formatted information about available skills."""


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
    skills: dict[str, Skill]
    hook_manager: HookManager
    _session_start_time: datetime = field(default_factory=datetime.now)
    _total_steps: int = 0
    _hook_env_vars: dict[str, str] = field(default_factory=dict)

    @staticmethod
    async def create(
        config: Config,
        oauth: OAuthManager,
        llm: LLM | None,
        session: Session,
        yolo: bool,
        skills_dir: KaosPath | None = None,
    ) -> Runtime:
        from kimi_cli.hooks.config import HookEventType
        from kimi_cli.hooks.models import SessionStartHookEvent

        ls_output, agents_md, environment = await asyncio.gather(
            list_directory(session.work_dir),
            load_agents_md(session.work_dir),
            Environment.detect(),
        )

        # Discover and format skills
        skills_roots = await resolve_skills_roots(session.work_dir, skills_dir_override=skills_dir)
        skills = await discover_skills_from_roots(skills_roots)
        skills_by_name = index_skills(skills)
        logger.info("Discovered {count} skill(s)", count=len(skills))
        skills_formatted = "\n".join(
            (
                f"- {skill.name}\n"
                f"  - Path: {skill.skill_md_file}\n"
                f"  - Description: {skill.description}"
            )
            for skill in skills
        )

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

        # Initialize hook manager
        hook_manager = HookManager(config.hooks).with_runtime(None)  # Will set runtime later

        session_start_time = datetime.now()

        runtime = Runtime(
            config=config,
            oauth=oauth,
            llm=llm,
            session=session,
            builtin_args=BuiltinSystemPromptArgs(
                KIMI_NOW=session_start_time.astimezone().isoformat(),
                KIMI_WORK_DIR=session.work_dir,
                KIMI_WORK_DIR_LS=ls_output,
                KIMI_AGENTS_MD=agents_md or "",
                KIMI_SKILLS=skills_formatted or "No skills found.",
            ),
            denwa_renji=DenwaRenji(),
            approval=Approval(state=approval_state),
            labor_market=LaborMarket(),
            environment=environment,
            skills=skills_by_name,
            hook_manager=hook_manager,
            _session_start_time=session_start_time,
            _total_steps=0,
        )

        # Set runtime reference in hook manager
        runtime.hook_manager = hook_manager.with_runtime(runtime)

        return runtime

    def copy_for_fixed_subagent(self) -> Runtime:
        """Clone runtime for fixed subagent."""
        return Runtime(
            config=self.config,
            oauth=self.oauth,
            llm=self.llm,
            session=self.session,
            builtin_args=self.builtin_args,
            denwa_renji=DenwaRenji(),  # subagent must have its own DenwaRenji
            approval=self.approval.share(),
            labor_market=LaborMarket(),  # fixed subagent has its own LaborMarket
            environment=self.environment,
            skills=self.skills,
            hook_manager=self.hook_manager,
            _session_start_time=self._session_start_time,
            _total_steps=self._total_steps,
            _hook_env_vars=self._hook_env_vars,
        )

    def copy_for_dynamic_subagent(self) -> Runtime:
        """Clone runtime for dynamic subagent."""
        return Runtime(
            config=self.config,
            oauth=self.oauth,
            llm=self.llm,
            session=self.session,
            builtin_args=self.builtin_args,
            denwa_renji=DenwaRenji(),  # subagent must have its own DenwaRenji
            approval=self.approval.share(),
            labor_market=self.labor_market,  # dynamic subagent shares LaborMarket with main agent
            environment=self.environment,
            skills=self.skills,
            hook_manager=self.hook_manager,
            _session_start_time=self._session_start_time,
            _total_steps=self._total_steps,
            _hook_env_vars=self._hook_env_vars,
        )

    async def _execute_session_start_hooks(self) -> list[str]:
        """Execute session_start hooks and return additional_contexts from results."""
        from kimi_cli.hooks.config import HookEventType
        from kimi_cli.hooks.models import SessionStartHookEvent

        event = SessionStartHookEvent(
            event_type=HookEventType.SESSION_START.value,
            timestamp=datetime.now(),
            session_id=self.session.id,
            work_dir=str(self.session.work_dir),
            model=self.llm.chat_provider.model_name if self.llm else None,
            args={},
        )

        results = await self.hook_manager.execute(HookEventType.SESSION_START, event)

        additional_contexts: list[str] = []
        for result in results:
            if result.additional_context:
                additional_contexts.append(result.additional_context)
            if not result.success:
                logger.warning(
                    "Session start hook {name} failed: {reason}",
                    name=result.hook_name,
                    reason=result.reason,
                )

        # Load environment variables from KIMI_ENV_FILE
        self._hook_env_vars = self.hook_manager.load_env_file()
        if self._hook_env_vars:
            logger.debug(
                "Loaded {count} env vars from hook env file",
                count=len(self._hook_env_vars),
            )

        return additional_contexts

    def get_hook_env_vars(self) -> dict[str, str]:
        """Get environment variables set by session_start hooks."""
        return self._hook_env_vars.copy()

    async def execute_session_end_hooks(self, exit_reason: str = "user_exit") -> None:
        """Execute session_end hooks."""
        from kimi_cli.hooks.config import HookEventType
        from kimi_cli.hooks.models import SessionEndHookEvent

        duration = int((datetime.now() - self._session_start_time).total_seconds())

        event = SessionEndHookEvent(
            event_type=HookEventType.SESSION_END.value,
            timestamp=datetime.now(),
            session_id=self.session.id,
            work_dir=str(self.session.work_dir),
            duration_seconds=duration,
            total_steps=self._total_steps,
            exit_reason=exit_reason,
        )

        results = await self.hook_manager.execute(HookEventType.SESSION_END, event)

        for result in results:
            if not result.success:
                logger.warning(
                    "Session end hook {name} failed: {reason}",
                    name=result.hook_name,
                    reason=result.reason,
                )

    def increment_step_count(self) -> None:
        """Increment the total step count."""
        self._total_steps += 1


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
    mcp_configs: list[MCPConfig] | list[dict[str, Any]],
    _restore_dynamic_subagents: bool = True,
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

    # load subagents before loading tools because Task tool depends on LaborMarket on initialization
    for subagent_name, subagent_spec in agent_spec.subagents.items():
        logger.debug("Loading subagent: {subagent_name}", subagent_name=subagent_name)
        subagent = await load_agent(
            subagent_spec.path,
            runtime.copy_for_fixed_subagent(),
            mcp_configs=mcp_configs,
            _restore_dynamic_subagents=False,
        )
        runtime.labor_market.add_fixed_subagent(subagent_name, subagent, subagent_spec.description)

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
    tools = agent_spec.tools
    if agent_spec.exclude_tools:
        logger.debug("Excluding tools: {tools}", tools=agent_spec.exclude_tools)
        tools = [tool for tool in tools if tool not in agent_spec.exclude_tools]
    toolset.load_tools(tools, tool_deps)

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
        await toolset.load_mcp_tools(validated_mcp_configs, runtime)

    # Restore dynamic subagents from persisted session state
    # Skip for fixed subagents — they have their own isolated LaborMarket
    if _restore_dynamic_subagents:
        for subagent_spec in runtime.session.state.dynamic_subagents:
            if subagent_spec.name not in runtime.labor_market.subagents:
                subagent = Agent(
                    name=subagent_spec.name,
                    system_prompt=subagent_spec.system_prompt,
                    toolset=toolset,
                    runtime=runtime.copy_for_dynamic_subagent(),
                )
                runtime.labor_market.add_dynamic_subagent(subagent_spec.name, subagent)

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
