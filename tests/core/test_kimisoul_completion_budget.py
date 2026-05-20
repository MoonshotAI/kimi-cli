from __future__ import annotations

from pathlib import Path

import pytest
from kosong.chat_provider.kimi import Kimi
from kosong.tooling.empty import EmptyToolset
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm import LLM
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Completion Budget Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _make_kimi_llm(chat_provider: Kimi, *, max_context_size: int = 100_000) -> LLM:
    return LLM(
        chat_provider=chat_provider,
        max_context_size=max_context_size,
        capabilities=set(),
        model_config=LLMModel(
            provider="kimi",
            model="kimi-k2",
            max_context_size=max_context_size,
        ),
        provider_config=LLMProvider(
            type="kimi",
            base_url="https://api.test/v1",
            api_key=SecretStr("test-key"),
        ),
    )


@pytest.mark.asyncio
async def test_dynamic_completion_budget_clamps_kimi_request(
    runtime: Runtime, tmp_path: Path
) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    runtime.llm = _make_kimi_llm(chat_provider)
    soul = _make_soul(runtime, tmp_path)
    await soul.context.update_token_count(60_000)

    budgeted = soul._with_dynamic_completion_budget(chat_provider)

    assert isinstance(budgeted, Kimi)
    assert budgeted.model_parameters["max_completion_tokens"] == 38_976


def test_dynamic_completion_budget_preserves_explicit_kimi_cap(
    runtime: Runtime, tmp_path: Path
) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    ).with_generation_kwargs(max_completion_tokens=1234)
    runtime.llm = _make_kimi_llm(chat_provider)
    soul = _make_soul(runtime, tmp_path)

    budgeted = soul._with_dynamic_completion_budget(chat_provider)

    assert budgeted.model_parameters["max_completion_tokens"] == 1234


@pytest.mark.asyncio
async def test_dynamic_completion_budget_clamps_explicit_kimi_cap(
    runtime: Runtime, tmp_path: Path
) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    ).with_generation_kwargs(max_completion_tokens=50_000)
    runtime.llm = _make_kimi_llm(chat_provider, max_context_size=8_192)
    soul = _make_soul(runtime, tmp_path)
    await soul.context.update_token_count(7_000)

    budgeted = soul._with_dynamic_completion_budget(chat_provider)

    assert budgeted.model_parameters["max_completion_tokens"] == 168
