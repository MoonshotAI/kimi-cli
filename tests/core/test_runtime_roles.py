from __future__ import annotations

from kosong.chat_provider.echo import EchoChatProvider

from kimi_cli.config import LLMModel
from kimi_cli.llm import LLM


def _make_test_llm(model_name: str, *, max_context_size: int) -> LLM:
    return LLM(
        chat_provider=EchoChatProvider(),
        max_context_size=max_context_size,
        capabilities=set(),
        model_config=LLMModel(
            provider="_echo",
            model=model_name,
            max_context_size=max_context_size,
        ),
    )


def test_runtime_roles_are_root_and_subagent_only(runtime):
    assert runtime.role == "root"

    subagent_runtime = runtime.copy_for_subagent(
        agent_id="atestrole",
        subagent_type="coder",
    )

    assert subagent_runtime.role == "subagent"


def test_subagent_runtime_reuses_active_llm_when_root_compaction_llm_is_too_small(runtime):
    runtime.llm = _make_test_llm("root-main", max_context_size=100_000)
    runtime.compaction_llm = _make_test_llm("root-compact", max_context_size=50_000)
    subagent_llm = _make_test_llm("subagent-main", max_context_size=200_000)

    subagent_runtime = runtime.copy_for_subagent(
        agent_id="atestcompact",
        subagent_type="coder",
        llm_override=subagent_llm,
    )

    assert subagent_runtime.llm is subagent_llm
    assert subagent_runtime.compaction_llm is subagent_llm
