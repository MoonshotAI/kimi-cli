"""Shared core logic for preparing a subagent soul.

Both ``ForegroundSubagentRunner`` and ``BackgroundAgentRunner`` delegate
the repetitive build-restore-prompt pipeline to :func:`prepare_soul` so
that prompt enhancements (e.g. git context injection) only need to be
implemented once.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.subagents.builder import SubagentBuilder
from kimi_cli.subagents.models import AgentLaunchSpec, AgentTypeDefinition
from kimi_cli.subagents.store import SubagentStore

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime


@dataclass(frozen=True, slots=True, kw_only=True)
class SubagentRunSpec:
    """Everything needed to prepare a soul, without lifecycle concerns."""

    agent_id: str
    type_def: AgentTypeDefinition
    launch_spec: AgentLaunchSpec
    prompt: str
    resumed: bool


async def prepare_soul(
    spec: SubagentRunSpec,
    runtime: Runtime,
    builder: SubagentBuilder,
    store: SubagentStore,
    on_stage: Callable[[str], None] | None = None,
) -> tuple[KimiSoul, str]:
    """Build agent, restore context, handle system prompt, write prompt file.

    Returns ``(soul, final_prompt)`` ready for execution via
    :func:`run_with_summary_continuation`.
    """

    # 1. Build agent from type definition
    agent = await builder.build_builtin_instance(
        agent_id=spec.agent_id,
        type_def=spec.type_def,
        launch_spec=spec.launch_spec,
    )
    if on_stage:
        on_stage("agent_built")

    # 2. Restore conversation context
    context = Context(store.context_path(spec.agent_id))
    await context.restore()
    if on_stage:
        on_stage("context_restored")

    # 3. System prompt: reuse persisted prompt on resume, persist on first run
    if context.system_prompt is not None:
        agent = replace(agent, system_prompt=context.system_prompt)
    else:
        await context.write_system_prompt(agent.system_prompt)
    if on_stage:
        on_stage("context_ready")

    # 4. For new (non-resumed) explore agents, prepend git context to the prompt
    prompt = spec.prompt
    if spec.type_def.name == "explore" and not spec.resumed:
        from kimi_cli.subagents.git_context import collect_git_context

        git_ctx = await collect_git_context(agent.runtime.builtin_args.KIMI_WORK_DIR)
        if git_ctx:
            prompt = f"{git_ctx}\n\n{prompt}"

    # 5. Write prompt snapshot (debugging aid)
    store.prompt_path(spec.agent_id).write_text(prompt, encoding="utf-8")

    # 6. Create soul
    soul = KimiSoul(agent, context=context)
    return soul, prompt
