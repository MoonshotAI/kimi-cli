from __future__ import annotations

from kimi_cli.constant import USER_AGENT
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

        # Determine the effective provider type so we only inject KIMI pool keys
        # into Kimi-provider subagents.
        provider_type: str | None = None
        if effective_model is None:
            llm = self._root_runtime.llm
            if llm is not None and llm.provider_config is not None:
                provider_type = llm.provider_config.type
        else:
            model_cfg = self._root_runtime.config.models.get(effective_model)
            if model_cfg is not None:
                provider_cfg = self._root_runtime.config.providers.get(model_cfg.provider)
                if provider_cfg is not None:
                    provider_type = provider_cfg.type

        # If a key pool is configured, rotate keys so concurrent subagents
        # do not share a single API-key rate-limit quota.
        api_key_override: str | None = None
        key_pool_for_clone = None
        if provider_type == "kimi" and self._root_runtime.key_pool is not None:
            api_key_override = self._root_runtime.key_pool.acquire()
            key_pool_for_clone = self._root_runtime.key_pool
            from kimi_cli.utils.logging import logger

            logger.info(
                "Subagent {agent_id} assigned API key from pool (pool size {n})",
                agent_id=agent_id,
                n=self._root_runtime.key_pool.key_count,
            )

        extra_headers = {"User-Agent": f"{USER_AGENT} (subagent: {type_def.name})"}
        llm_override = clone_llm_with_model_alias(
            self._root_runtime.llm,
            self._root_runtime.config,
            effective_model,
            session_id=self._root_runtime.session.id,
            oauth=self._root_runtime.oauth,
            api_key_override=api_key_override,
            key_pool=key_pool_for_clone,
            extra_headers=extra_headers,
        )
        runtime = self._root_runtime.copy_for_subagent(
            agent_id=agent_id,
            subagent_type=type_def.name,
            llm_override=llm_override,
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
