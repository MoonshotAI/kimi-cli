from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from kosong.chat_provider import APIConnectionError
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

    overrides = soul._compute_completion_overrides(chat_provider)

    assert overrides == {"max_completion_tokens": 40_000}


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

    overrides = soul._compute_completion_overrides(chat_provider)

    assert overrides == {"max_completion_tokens": 1234}


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

    overrides = soul._compute_completion_overrides(chat_provider)

    assert overrides == {"max_completion_tokens": 1_192}


def test_dynamic_completion_budget_uses_full_context_without_explicit_cap(
    runtime: Runtime, tmp_path: Path
) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    runtime.llm = _make_kimi_llm(chat_provider, max_context_size=262_144)
    soul = _make_soul(runtime, tmp_path)

    assert soul._compute_completion_overrides(chat_provider) == {"max_completion_tokens": 262_144}


def test_dynamic_completion_budget_can_be_disabled(runtime: Runtime, tmp_path: Path) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    ).with_generation_kwargs(max_completion_tokens=None)
    runtime.llm = _make_kimi_llm(chat_provider)
    soul = _make_soul(runtime, tmp_path)

    assert soul._compute_completion_overrides(chat_provider) is None


def test_compute_completion_overrides_returns_none_for_non_kimi_provider(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Non-Kimi providers receive no overrides and run with their built-in defaults."""

    class _NotKimi:
        name = "not-kimi"

        @property
        def model_name(self) -> str:
            return "stub"

        @property
        def thinking_effort(self) -> None:
            return None

        async def generate(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover - unused
            raise NotImplementedError

        def with_thinking(self, effort: Any) -> _NotKimi:  # pragma: no cover - unused
            return self

    soul = _make_soul(runtime, tmp_path)

    assert soul._compute_completion_overrides(_NotKimi()) is None  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_compute_overrides_does_not_copy_chat_provider(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Regression for F3: the dynamic budget must not produce a shallow copy of the
    chat provider that shadows ``runtime.llm.chat_provider``.

    Before the fix, ``_with_dynamic_completion_budget`` returned a fresh ``Kimi`` instance
    via ``with_generation_kwargs``. That copy shared ``client``/``_api_key`` with the
    original, but ``on_retryable_error`` rebound ``self.client`` only on the copy — so the
    runtime's ``chat_provider`` was left pointing at the (now-closed) old client and every
    subsequent step had to recover from a dead connection first.

    With the new design ``_compute_completion_overrides`` returns a plain dict and the
    runtime keeps owning the single live provider instance, so recovery on it is the
    visible state for the next step.
    """
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    runtime.llm = _make_kimi_llm(chat_provider)
    soul = _make_soul(runtime, tmp_path)
    await soul.context.update_token_count(1_000)

    overrides = soul._compute_completion_overrides(runtime.llm.chat_provider)

    # The override path returns data, not a substitute provider.
    assert isinstance(overrides, dict)
    assert runtime.llm.chat_provider is chat_provider

    # When a transient error triggers recovery on the live provider, the next call to
    # ``_compute_completion_overrides`` still sees the same instance — proof that
    # the budget calculation has not forked a parallel provider that would mask
    # the client refresh.
    original_client = chat_provider.client
    chat_provider.on_retryable_error(APIConnectionError("simulated"))
    assert chat_provider.client is not original_client
    runtime_provider = runtime.llm.chat_provider
    assert isinstance(runtime_provider, Kimi)
    assert runtime_provider.client is chat_provider.client

    overrides_after_recovery = soul._compute_completion_overrides(runtime_provider)
    assert isinstance(overrides_after_recovery, dict)
    assert runtime_provider is chat_provider
