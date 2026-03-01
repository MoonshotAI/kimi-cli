from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Self

import pytest
from kosong.chat_provider import (
    APIConnectionError,
    APIStatusError,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.message import Message, TextPart
from kosong.tooling import Tool
from kosong.tooling.simple import SimpleToolset

from kimi_cli.llm import LLM
from kimi_cli.soul import run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire


class StaticStreamedMessage:
    def __init__(self, parts: Sequence[StreamedMessagePart]) -> None:
        self._iter = self._to_stream(parts)

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        return await self._iter.__anext__()

    async def _to_stream(
        self, parts: Sequence[StreamedMessagePart]
    ) -> AsyncIterator[StreamedMessagePart]:
        for part in parts:
            yield part

    @property
    def id(self) -> str | None:
        return "recovering"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class RecoveringSequenceProvider:
    name = "recovering-sequence"

    def __init__(self) -> None:
        self.generate_attempts = 0
        self.recovery_calls = 0

    @property
    def model_name(self) -> str:
        return "recovering-sequence"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        self.generate_attempts += 1
        if self.generate_attempts == 1:
            raise APIConnectionError("Connection error.")
        return StaticStreamedMessage([TextPart(text="recovered")])

    def on_retryable_error(self, error: BaseException) -> bool:
        self.recovery_calls += 1
        return True

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class AlwaysConnectionErrorProvider:
    name = "always-connection-error"

    def __init__(self) -> None:
        self.generate_attempts = 0
        self.recovery_calls = 0

    @property
    def model_name(self) -> str:
        return "always-connection-error"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        self.generate_attempts += 1
        raise APIConnectionError("Connection error.")

    def on_retryable_error(self, error: BaseException) -> bool:
        self.recovery_calls += 1
        return True

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class StatusErrorThenSuccessProvider:
    name = "status-error-then-success"

    def __init__(self) -> None:
        self.generate_attempts = 0
        self.recovery_calls = 0

    @property
    def model_name(self) -> str:
        return "status-error-then-success"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        self.generate_attempts += 1
        if self.generate_attempts < 3:
            raise APIStatusError(503, "Service unavailable.")
        return StaticStreamedMessage([TextPart(text="status recovered")])

    def on_retryable_error(self, error: BaseException) -> bool:
        self.recovery_calls += 1
        return True

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class NonRetryableConnectionProvider:
    name = "non-retryable-connection"

    def __init__(self) -> None:
        self.generate_attempts = 0

    @property
    def model_name(self) -> str:
        return "non-retryable-connection"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StaticStreamedMessage:
        self.generate_attempts += 1
        if self.generate_attempts == 1:
            raise APIConnectionError("Connection error.")
        return StaticStreamedMessage([TextPart(text="non-retryable recovered")])

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


def _runtime_with_llm(runtime: Runtime, llm: LLM) -> Runtime:
    return Runtime(
        config=runtime.config,
        llm=llm,
        session=runtime.session,
        builtin_args=runtime.builtin_args,
        denwa_renji=runtime.denwa_renji,
        approval=runtime.approval,
        labor_market=runtime.labor_market,
        environment=runtime.environment,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
    )


def _make_soul(runtime: Runtime, llm: LLM, tmp_path: Path) -> tuple[KimiSoul, Context]:
    agent = Agent(
        name="Retry Test Agent",
        system_prompt="Retry test prompt.",
        toolset=SimpleToolset(),
        runtime=_runtime_with_llm(runtime, llm),
    )
    context = Context(file_backend=tmp_path / "history.jsonl")
    return KimiSoul(agent, context=context), context


async def _drain_ui_messages(wire: Wire) -> None:
    wire_ui = wire.ui_side(merge=True)
    while True:
        try:
            await wire_ui.receive()
        except QueueShutDown:
            return


@pytest.mark.asyncio
async def test_step_retry_recovers_retryable_provider(runtime: Runtime, tmp_path: Path) -> None:
    runtime.config.loop_control.max_retries_per_step = 2
    provider = RecoveringSequenceProvider()
    llm = LLM(
        chat_provider=provider,
        max_context_size=100_000,
        capabilities=set(),
    )
    soul, context = _make_soul(runtime, llm, tmp_path)

    await run_soul(soul, "trigger recovery", _drain_ui_messages, asyncio.Event())

    assert provider.generate_attempts == 2
    assert provider.recovery_calls == 1
    assert context.history[-1].extract_text(" ").strip() == "recovered"


@pytest.mark.asyncio
async def test_step_connection_error_recovery_only_retries_once(
    runtime: Runtime, tmp_path: Path
) -> None:
    runtime.config.loop_control.max_retries_per_step = 5
    provider = AlwaysConnectionErrorProvider()
    llm = LLM(
        chat_provider=provider,
        max_context_size=100_000,
        capabilities=set(),
    )
    soul, _ = _make_soul(runtime, llm, tmp_path)

    with pytest.raises(APIConnectionError):
        await run_soul(soul, "trigger connection failure", _drain_ui_messages, asyncio.Event())

    assert provider.generate_attempts == 2
    assert provider.recovery_calls == 1


@pytest.mark.asyncio
async def test_step_status_error_still_uses_tenacity_retries(
    runtime: Runtime, tmp_path: Path
) -> None:
    runtime.config.loop_control.max_retries_per_step = 3
    provider = StatusErrorThenSuccessProvider()
    llm = LLM(
        chat_provider=provider,
        max_context_size=100_000,
        capabilities=set(),
    )
    soul, context = _make_soul(runtime, llm, tmp_path)

    await run_soul(soul, "trigger status retry", _drain_ui_messages, asyncio.Event())

    assert provider.generate_attempts == 3
    assert provider.recovery_calls == 0
    assert context.history[-1].extract_text(" ").strip() == "status recovered"


@pytest.mark.asyncio
async def test_step_non_retryable_provider_keeps_tenacity_connection_retries(
    runtime: Runtime, tmp_path: Path
) -> None:
    runtime.config.loop_control.max_retries_per_step = 2
    provider = NonRetryableConnectionProvider()
    llm = LLM(
        chat_provider=provider,
        max_context_size=100_000,
        capabilities=set(),
    )
    soul, context = _make_soul(runtime, llm, tmp_path)

    await run_soul(
        soul, "trigger non-retryable connection retry", _drain_ui_messages, asyncio.Event()
    )

    assert provider.generate_attempts == 2
    assert context.history[-1].extract_text(" ").strip() == "non-retryable recovered"
