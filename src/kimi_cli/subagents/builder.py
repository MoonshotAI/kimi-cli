from __future__ import annotations

from kimi_cli.llm import clone_llm_with_model_alias
from kimi_cli.soul.agent import Agent, Runtime, load_agent
from kimi_cli.subagents.models import AgentLaunchSpec, AgentTypeDefinition


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
        runtime = self._root_runtime.copy_for_subagent(
            agent_id=agent_id,
            subagent_type=type_def.name,
            llm_override=llm_override,
        )
        return await load_agent(
            type_def.agent_file,
            runtime,
            mcp_configs=self._root_runtime.mcp_configs,
        )

    @staticmethod
    def resolve_effective_model(
        *, type_def: AgentTypeDefinition, launch_spec: AgentLaunchSpec
    ) -> str | None:
        return launch_spec.model_override or launch_spec.effective_model or type_def.default_model
