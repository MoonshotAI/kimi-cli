from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from kosong.chat_provider import APIConnectionError, ChatProvider
from kosong.chat_provider.chaos import ChaosChatProvider, ChaosConfig
from kosong.chat_provider.kimi import Kimi
from kosong.chat_provider.mock import MockChatProvider, MockStreamedMessage
from kosong.message import Message
from kosong.tooling import Tool
from kosong.tooling.empty import EmptyToolset
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm import (
    DEFAULT_COMPLETION_TOKEN_SAFETY_MARGIN,
    LLM,
    estimate_request_tokens,
    with_kimi_generation_overrides,
)
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.compaction import (
    COMPACTION_OUTPUT_PREFIX,
    COMPACTION_SYSTEM_PROMPT,
    CompactionResult,
)
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.message import system


def _make_soul(
    runtime: Runtime, tmp_path: Path, *, system_prompt: str = "Test prompt."
) -> KimiSoul:
    agent = Agent(
        name="Completion Budget Test Agent",
        system_prompt=system_prompt,
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _make_kimi_llm(chat_provider: ChatProvider, *, max_context_size: int = 100_000) -> LLM:
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


def _compute_overrides(
    soul: KimiSoul,
    chat_provider: Any,
    *,
    system_prompt: str = "Test prompt.",
    tools: list[Tool] | None = None,
    history: list[Message] | None = None,
) -> dict[str, Any] | None:
    return soul._compute_completion_overrides(
        chat_provider,
        system_prompt=system_prompt,
        tools=tools or [],
        history=history or [],
        input_tokens_floor=soul.context.token_count_with_pending,
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

    overrides = _compute_overrides(soul, chat_provider)

    assert overrides == {"max_completion_tokens": 38_976}


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

    overrides = _compute_overrides(soul, chat_provider)

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

    overrides = _compute_overrides(soul, chat_provider)

    assert overrides == {"max_completion_tokens": 168}


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

    request_tokens = estimate_request_tokens("Test prompt.", [], [])
    assert _compute_overrides(soul, chat_provider) == {
        "max_completion_tokens": 262_144 - request_tokens - DEFAULT_COMPLETION_TOKEN_SAFETY_MARGIN
    }


def test_dynamic_completion_budget_counts_full_first_request(
    runtime: Runtime, tmp_path: Path
) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    runtime.llm = _make_kimi_llm(chat_provider, max_context_size=8_192)
    soul = _make_soul(runtime, tmp_path)
    system_prompt = "system instruction " * 200
    tools = [
        Tool(
            name="lookup",
            description="Look up a value " * 40,
            parameters={
                "type": "object",
                "properties": {"query": {"type": "string", "description": "search term"}},
                "required": ["query"],
            },
        )
    ]
    history = [Message(role="user", content="hi")]

    overrides = _compute_overrides(
        soul,
        chat_provider,
        system_prompt=system_prompt,
        tools=tools,
        history=history,
    )

    assert overrides is not None
    input_tokens = estimate_request_tokens(system_prompt, tools, history)
    assert input_tokens > 0
    assert (
        input_tokens + DEFAULT_COMPLETION_TOKEN_SAFETY_MARGIN + overrides["max_completion_tokens"]
        <= 8_192
    )


def test_dynamic_completion_budget_can_be_disabled(runtime: Runtime, tmp_path: Path) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    ).with_generation_kwargs(max_completion_tokens=None)
    runtime.llm = _make_kimi_llm(chat_provider)
    soul = _make_soul(runtime, tmp_path)

    assert _compute_overrides(soul, chat_provider) is None


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

    assert _compute_overrides(soul, _NotKimi()) is None


def test_request_overrides_leave_non_kimi_provider_untouched() -> None:
    chat_provider = MockChatProvider([])

    assert with_kimi_generation_overrides(chat_provider, None) is chat_provider
    assert with_kimi_generation_overrides(chat_provider, {}) is chat_provider
    assert (
        with_kimi_generation_overrides(
            chat_provider,
            {"max_completion_tokens": 4096},
        )
        is chat_provider
    )


@pytest.mark.asyncio
async def test_request_overrides_reach_kimi_and_chaos_kimi(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kimi_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    chaos_provider = ChaosChatProvider(
        kimi_provider,
        chaos_config=ChaosConfig(
            error_probability=0,
            corrupt_tool_call_probability=0,
        ),
    )
    captured_overrides: list[Any] = []

    async def fake_generate(
        self: Kimi,
        system_prompt: str,
        tools: Any,
        history: Any,
        *,
        generation_overrides: Any = None,
    ) -> MockStreamedMessage:
        del self, system_prompt, tools, history
        captured_overrides.append(generation_overrides)
        return MockStreamedMessage([])

    monkeypatch.setattr(Kimi, "generate", fake_generate)

    for provider in (kimi_provider, chaos_provider):
        request_provider = with_kimi_generation_overrides(
            provider,
            {"max_completion_tokens": 4096},
        )
        await request_provider.generate("system", [], [])

    assert captured_overrides == [
        {"max_completion_tokens": 4096},
        {"max_completion_tokens": 4096},
    ]


def test_dynamic_completion_budget_unwraps_chaos_kimi_provider(
    runtime: Runtime, tmp_path: Path
) -> None:
    kimi_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    chat_provider = ChaosChatProvider(
        kimi_provider,
        chaos_config=ChaosConfig(
            error_probability=0,
            corrupt_tool_call_probability=0,
        ),
    )
    runtime.llm = _make_kimi_llm(chat_provider, max_context_size=8_192)
    soul = _make_soul(runtime, tmp_path)

    overrides = _compute_overrides(soul, chat_provider)

    assert overrides is not None
    assert overrides["max_completion_tokens"] < 8_192
    assert chat_provider.wrapped_provider is kimi_provider


@pytest.mark.asyncio
async def test_compaction_budget_reserves_next_main_request_overhead(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chat_provider = Kimi(
        model="kimi-k2",
        base_url="https://api.test/v1",
        api_key="test-key",
        stream=False,
    )
    runtime.llm = _make_kimi_llm(chat_provider, max_context_size=8_192)
    soul = _make_soul(runtime, tmp_path, system_prompt="large system prompt " * 300)
    original_messages = [
        Message(role="user", content="old context " * 500),
        Message(role="assistant", content="old response " * 500),
        Message(role="user", content="preserved question " * 300),
        Message(role="assistant", content="preserved answer " * 300),
    ]
    await soul.context.append_message(original_messages)
    captured_overrides: dict[str, Any] | None = None

    def fake_with_overrides(provider: ChatProvider, overrides: Any) -> ChatProvider:
        nonlocal captured_overrides
        captured_overrides = overrides
        return provider

    async def fake_compact(
        messages: Any,
        llm: LLM,
        *,
        custom_instruction: str = "",
    ) -> Any:
        del messages, llm, custom_instruction
        return CompactionResult(
            messages=[Message(role="user", content="summary")],
            usage=None,
        )

    monkeypatch.setattr(soul._compaction, "compact", fake_compact)
    monkeypatch.setattr(
        "kimi_cli.soul.kimisoul.with_kimi_generation_overrides",
        fake_with_overrides,
    )
    monkeypatch.setattr("kimi_cli.soul.kimisoul.wire_send", lambda _message: None)

    await soul.compact_context(manual=True)

    assert captured_overrides is not None
    prepared = soul._compaction.prepare(original_messages)
    assert prepared.compact_message is not None
    compaction_request_tokens = estimate_request_tokens(
        COMPACTION_SYSTEM_PROMPT,
        [],
        [prepared.compact_message],
    )
    next_request_tokens = estimate_request_tokens(
        soul._agent.system_prompt,
        soul._agent.toolset.tools,
        [
            Message(role="user", content=[system(COMPACTION_OUTPUT_PREFIX)]),
            *prepared.to_preserve,
        ],
    )
    assert next_request_tokens > compaction_request_tokens
    assert (
        next_request_tokens
        + DEFAULT_COMPLETION_TOKEN_SAFETY_MARGIN
        + captured_overrides["max_completion_tokens"]
        <= runtime.llm.max_context_size
    )


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

    overrides = _compute_overrides(soul, runtime.llm.chat_provider)

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

    overrides_after_recovery = _compute_overrides(soul, runtime_provider)
    assert isinstance(overrides_after_recovery, dict)
    assert runtime_provider is chat_provider
