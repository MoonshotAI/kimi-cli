from __future__ import annotations

from dataclasses import replace

from kaos.path import KaosPath

from kimi_cli.llm import clone_llm_with_model_alias
from kimi_cli.soul.agent import Agent, Runtime, load_agent, load_agents_md
from kimi_cli.subagents.models import AgentLaunchSpec, AgentTypeDefinition
from kimi_cli.utils.logging import logger


class SubagentBuilder:
    def __init__(self, root_runtime: Runtime):
        self._root_runtime = root_runtime

    async def build_builtin_instance(
        self,
        *,
        agent_id: str,
        type_def: AgentTypeDefinition,
        launch_spec: AgentLaunchSpec,
    ) -> Agent:
        effective_model = self.resolve_effective_model(type_def=type_def, launch_spec=launch_spec)
        llm_override = clone_llm_with_model_alias(
            self._root_runtime.llm,
            self._root_runtime.config,
            effective_model,
            session_id=self._root_runtime.session.id,
            oauth=self._root_runtime.oauth,
        )
        work_dir_override: KaosPath | None = None
        if launch_spec.work_dir is not None:
            candidate = KaosPath(launch_spec.work_dir)
            if not candidate.is_absolute():
                logger.warning(
                    "Ignoring non-absolute work_dir override: {path}",
                    path=launch_spec.work_dir,
                )
            else:
                work_dir_override = candidate
        runtime = self._root_runtime.copy_for_subagent(
            agent_id=agent_id,
            subagent_type=type_def.name,
            llm_override=llm_override,
            work_dir_override=work_dir_override,
        )
        # Refresh directory listing and AGENTS.md for the overridden work_dir so the
        # system prompt reflects the correct project structure and guidelines.
        if work_dir_override is not None:
            from kimi_cli.utils.path import list_directory

            try:
                ls_output = await list_directory(work_dir_override)
            except OSError:
                ls_output = "[directory not readable]"
            agents_md = await load_agents_md(work_dir_override)
            runtime = replace(
                runtime,
                builtin_args=replace(
                    runtime.builtin_args,
                    KIMI_WORK_DIR_LS=ls_output,
                    KIMI_AGENTS_MD=agents_md or "",
                ),
            )
        return await load_agent(
            type_def.agent_file,
            runtime,
            mcp_configs=[],
        )

    @staticmethod
    def resolve_effective_model(
        *, type_def: AgentTypeDefinition, launch_spec: AgentLaunchSpec
    ) -> str | None:
        return launch_spec.model_override or launch_spec.effective_model or type_def.default_model
