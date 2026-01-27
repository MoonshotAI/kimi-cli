from __future__ import annotations

import asyncio
import string
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pydantic
from kaos.path import KaosPath
from kosong.tooling import Toolset

from kimi_cli.agentspec import load_agent_spec
from kimi_cli.config import Config
from kimi_cli.exception import MCPConfigError
from kimi_cli.lessons import LessonExtractor, LessonJudge, LessonManager
from kimi_cli.llm import LLM
from kimi_cli.session import Session
from kimi_cli.skill import (
    Skill,
    discover_skills_from_roots,
    index_skills,
    resolve_skills_roots,
)
from kimi_cli.soul.approval import Approval
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
    llm: LLM | None  # we do not freeze the `Runtime` dataclass because LLM can be changed
    session: Session
    builtin_args: BuiltinSystemPromptArgs
    denwa_renji: DenwaRenji
    approval: Approval
    labor_market: LaborMarket
    environment: Environment
    skills: dict[str, Skill]
    skills_roots: list[KaosPath]
    """Roots for skill discovery, used for dynamic re-discovery."""

    # Lessons system
    lesson_manager: LessonManager | None = None
    lesson_extractor: LessonExtractor | None = None

    @staticmethod
    async def create(
        config: Config,
        llm: LLM | None,
        session: Session,
        yolo: bool,
        skills_dir: KaosPath | None = None,
    ) -> Runtime:
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

        # Initialize lessons system
        lesson_manager: LessonManager | None = None
        lesson_extractor: LessonExtractor | None = None

        if config.lessons.enabled:
            from pathlib import Path

            # LessonManager operates on the project work directory
            # It will find/create skills dir under .kimi/skills, .agent/skills, or .claude/skills
            lesson_manager = LessonManager(Path(str(session.work_dir)))

            # Count lessons
            lessons_count = len([s for s in skills if s.type == "lesson"])
            logger.info("Discovered {count} lesson(s)", count=lessons_count)

            # Initialize judge (always uses LLM for judgment)
            judge = LessonJudge(llm)

            # Initialize extractor
            if config.lessons.auto_extract:
                lesson_extractor = LessonExtractor(
                    manager=lesson_manager,
                    judge=judge,
                    window_size=config.lessons.window_size,
                    session_id=session.id,
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
                KIMI_SKILLS=skills_formatted or "No skills found.",
            ),
            denwa_renji=DenwaRenji(),
            approval=Approval(yolo=yolo),
            labor_market=LaborMarket(),
            environment=environment,
            skills=skills_by_name,
            skills_roots=skills_roots,
            lesson_manager=lesson_manager,
            lesson_extractor=lesson_extractor,
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
            skills=self.skills,
            skills_roots=self.skills_roots,
            # Lessons: subagents share the same manager but don't extract
            lesson_manager=self.lesson_manager,
            lesson_extractor=None,  # subagents don't extract lessons
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
            skills=self.skills,
            skills_roots=self.skills_roots,
            # Lessons: subagents share the same manager but don't extract
            lesson_manager=self.lesson_manager,
            lesson_extractor=None,  # subagents don't extract lessons
        )

    async def refresh_skills(self) -> str:
        """
        Dynamically re-discover skills and return formatted string.

        This is called at each step to pick up newly created lessons.

        Returns:
            Formatted skills string for system prompt injection.
        """
        skills = await discover_skills_from_roots(self.skills_roots)
        self.skills.clear()
        self.skills.update(index_skills(skills))
        logger.debug("Refreshed skills: {count} skill(s)", count=len(skills))

        if not skills:
            return "No skills found."

        return "\n".join(
            (
                f"- {skill.name}\n"
                f"  - Path: {skill.skill_md_file}\n"
                f"  - Description: {skill.description}"
            )
            for skill in skills
        )


@dataclass(frozen=True, slots=True, kw_only=True)
class Agent:
    """The loaded agent."""

    name: str
    system_prompt_template: str
    """System prompt template with ${KIMI_SKILLS} placeholder for dynamic substitution."""
    toolset: Toolset
    runtime: Runtime
    """Each agent has its own runtime, which should be derived from its main agent."""

    def build_system_prompt(self, skills_formatted: str) -> str:
        """
        Build the system prompt with dynamically discovered skills.

        Args:
            skills_formatted: Formatted skills string from runtime.refresh_skills().

        Returns:
            Complete system prompt with skills injected.
        """
        # Create a copy of builtin_args with updated KIMI_SKILLS
        args = asdict(self.runtime.builtin_args)
        args["KIMI_SKILLS"] = skills_formatted
        return string.Template(self.system_prompt_template).safe_substitute(args)


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
) -> Agent:
    """
    Load agent from specification file.

    Raises:
        FileNotFoundError: When the agent file is not found.
        AgentSpecError(KimiCLIException, ValueError): When the agent specification is invalid.
        InvalidToolError(KimiCLIException, ValueError): When any tool cannot be loaded.
        MCPConfigError(KimiCLIException, ValueError): When any MCP configuration is invalid.
        MCPRuntimeError(KimiCLIException, RuntimeError): When any MCP server cannot be connected.
    """
    logger.info("Loading agent: {agent_file}", agent_file=agent_file)
    agent_spec = load_agent_spec(agent_file)

    system_prompt_template = _load_system_prompt_template(
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

    return Agent(
        name=agent_spec.name,
        system_prompt_template=system_prompt_template,
        toolset=toolset,
        runtime=runtime,
    )


def _load_system_prompt_template(
    path: Path, args: dict[str, str], builtin_args: BuiltinSystemPromptArgs
) -> str:
    """
    Load system prompt template with partial substitution.

    Substitutes all variables except KIMI_SKILLS, which will be substituted
    dynamically at each step.

    Args:
        path: Path to the system prompt template file.
        args: Additional arguments from agent spec.
        builtin_args: Builtin arguments (KIMI_NOW, KIMI_WORK_DIR, etc.).

    Returns:
        System prompt template with KIMI_SKILLS placeholder preserved.
    """
    logger.info("Loading system prompt template: {path}", path=path)
    template_content = path.read_text(encoding="utf-8").strip()

    # Build substitution dict without KIMI_SKILLS (preserve it for dynamic substitution)
    builtin_dict = asdict(builtin_args)
    # Remove KIMI_SKILLS so it remains as a placeholder
    builtin_dict.pop("KIMI_SKILLS", None)

    logger.debug(
        "Partial substitution with builtin args (excluding KIMI_SKILLS), spec args: {spec_args}",
        spec_args=args,
    )
    # Use safe_substitute to preserve ${KIMI_SKILLS} placeholder
    return string.Template(template_content).safe_substitute(builtin_dict, **args)
