"""Soul-level tests for the MessageDisplay hook wiring in ``KimiSoul._step``.

Uses scripted chat providers (same pattern as test_kimisoul_retry_recovery.py)
plus a duck-typed hook engine that records trigger calls, to pin the contract:

- a fast stream fires exactly one ``is_final: true`` payload with the full
  cumulative text, before the end-of-turn ``Stop`` hook;
- thinking parts are not displayed text;
- no configured hooks -> no dispatcher, turn unaffected;
- cancellation mid-stream suppresses the final payload.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any, Self

import pytest
from kosong.chat_provider import StreamedMessagePart, ThinkingEffort, TokenUsage
from kosong.message import Message, TextPart, ThinkPart
from kosong.tooling import Tool
from kosong.tooling.simple import SimpleToolset

from kimi_cli.llm import LLM
from kimi_cli.soul import RunCancelled, run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire


class _StaticStreamedMessage:
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
        return "message-display"

    @property
    def usage(self) -> TokenUsage | None:
        return None

    @property
    def trace_id(self) -> str | None:
        return None


class _BlockingStreamedMessage(_StaticStreamedMessage):
    """Streams the given parts, then blocks until the task is cancelled."""

    async def _to_stream(
        self, parts: Sequence[StreamedMessagePart]
    ) -> AsyncIterator[StreamedMessagePart]:
        for part in parts:
            yield part
        await asyncio.Future()  # never completes; cancelled by run_soul


class _ScriptedProvider:
    name = "message-display-scripted"

    def __init__(self, message: _StaticStreamedMessage) -> None:
        self._message = message

    @property
    def model_name(self) -> str:
        return "message-display-scripted"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> _StaticStreamedMessage:
        return self._message

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


class _RecordingHookEngine:
    """Duck-typed HookEngine replacement capturing trigger calls."""

    def __init__(self) -> None:
        self.triggers: list[tuple[str, dict[str, Any]]] = []

    def has_hooks_for(self, event: str) -> bool:
        return True

    async def trigger(
        self, event: str, *, matcher_value: str = "", input_data: dict[str, Any]
    ) -> list[Any]:
        self.triggers.append((event, input_data))
        return []

    def fire_and_forget_trigger(
        self, event: str, *, matcher_value: str = "", input_data: dict[str, Any]
    ) -> asyncio.Task[list[Any]]:
        return asyncio.create_task(
            self.trigger(event, matcher_value=matcher_value, input_data=input_data)
        )


def _make_soul(
    runtime: Runtime, message: _StaticStreamedMessage, tmp_path: Path
) -> tuple[KimiSoul, Context]:
    llm = LLM(
        chat_provider=_ScriptedProvider(message),  # type: ignore[arg-type]
        max_context_size=100_000,
        capabilities=set(),
    )
    agent = Agent(
        name="MessageDisplay Test Agent",
        system_prompt="MessageDisplay test prompt.",
        toolset=SimpleToolset(),
        runtime=Runtime(
            config=runtime.config,
            llm=llm,
            session=runtime.session,
            builtin_args=runtime.builtin_args,
            denwa_renji=runtime.denwa_renji,
            approval=runtime.approval,
            labor_market=runtime.labor_market,
            environment=runtime.environment,
            notifications=runtime.notifications,
            background_tasks=runtime.background_tasks,
            skills=runtime.skills,
            oauth=runtime.oauth,
            additional_dirs=runtime.additional_dirs,
            skills_dirs=runtime.skills_dirs,
            role=runtime.role,
        ),
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


def _message_display_payloads(engine: _RecordingHookEngine) -> list[dict[str, Any]]:
    return [data for event, data in engine.triggers if event == "MessageDisplay"]


@pytest.mark.asyncio
async def test_final_fires_with_cumulative_text_before_stop(
    runtime: Runtime, tmp_path: Path
) -> None:
    engine = _RecordingHookEngine()
    message = _StaticStreamedMessage([TextPart(text="Hello"), TextPart(text=" world")])
    soul, _context = _make_soul(runtime, message, tmp_path)
    soul.set_hook_engine(engine)  # type: ignore[arg-type]

    await run_soul(soul, "hi", _drain_ui_messages, asyncio.Event())

    # The scripted stream completes inside the debounce window, so only the
    # unconditional final firing is expected.
    payloads = _message_display_payloads(engine)
    assert len(payloads) == 1
    assert payloads[0]["is_final"] is True
    assert payloads[0]["displayed_text"] == "Hello world"
    assert payloads[0]["message_id"]
    assert payloads[0]["session_id"] == runtime.session.id

    # is_final lands before the end-of-turn Stop hook.
    fired_events = [event for event, _ in engine.triggers]
    assert fired_events.index("MessageDisplay") < fired_events.index("Stop")


@pytest.mark.asyncio
async def test_thinking_parts_are_not_displayed_text(runtime: Runtime, tmp_path: Path) -> None:
    engine = _RecordingHookEngine()
    message = _StaticStreamedMessage([ThinkPart(think="hmm"), TextPart(text="answer")])
    soul, _context = _make_soul(runtime, message, tmp_path)
    soul.set_hook_engine(engine)  # type: ignore[arg-type]

    await run_soul(soul, "hi", _drain_ui_messages, asyncio.Event())

    payloads = _message_display_payloads(engine)
    assert len(payloads) == 1
    assert payloads[0]["displayed_text"] == "answer"


@pytest.mark.asyncio
async def test_no_dispatcher_without_configured_hooks(runtime: Runtime, tmp_path: Path) -> None:
    # The default empty HookEngine has no MessageDisplay hooks, so no
    # dispatcher is created and the turn is unaffected.
    message = _StaticStreamedMessage([TextPart(text="plain")])
    soul, context = _make_soul(runtime, message, tmp_path)

    await run_soul(soul, "hi", _drain_ui_messages, asyncio.Event())

    assert context.history[-1].extract_text(" ").strip() == "plain"


@pytest.mark.asyncio
async def test_cancellation_suppresses_is_final(runtime: Runtime, tmp_path: Path) -> None:
    engine = _RecordingHookEngine()
    message = _BlockingStreamedMessage([TextPart(text="partial")])
    soul, _context = _make_soul(runtime, message, tmp_path)
    soul.set_hook_engine(engine)  # type: ignore[arg-type]

    cancel = asyncio.Event()
    run_task = asyncio.create_task(run_soul(soul, "hi", _drain_ui_messages, cancel))
    await asyncio.sleep(0.1)  # let the stream reach the blocking point
    cancel.set()
    with pytest.raises(RunCancelled):
        await run_task

    finals = [p for p in _message_display_payloads(engine) if p["is_final"]]
    assert finals == []
