from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from kosong import StepResult
from kosong.message import ContentPart, Message
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.llm import LLM, ModelCapability
from kimi_cli.soul import LLMNotSupported, run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.dynamic_injection import DynamicInjection
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.message import is_system_reminder_message
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.types import ImageURLPart, SteerInput, StepBegin, TextPart, TurnBegin, TurnEnd


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Steer Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


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


def _llm_with_capabilities(runtime: Runtime, capabilities: set[ModelCapability]) -> LLM:
    assert runtime.llm is not None
    return LLM(
        chat_provider=runtime.llm.chat_provider,
        max_context_size=runtime.llm.max_context_size,
        capabilities=capabilities,
        model_config=runtime.llm.model_config,
        provider_config=runtime.llm.provider_config,
    )


@pytest.mark.asyncio
async def test_inject_steer_appends_plain_user_message(runtime: Runtime, tmp_path: Path) -> None:
    soul = _make_soul(runtime, tmp_path)

    await soul._inject_steer("Stop after summarizing the diff.")

    assert len(soul.context.history) == 1
    message = soul.context.history[0]
    assert message.role == "user"
    assert message.content == [TextPart(text="Stop after summarizing the diff.")]


@pytest.mark.asyncio
async def test_inject_steer_preserves_content_parts(runtime: Runtime, tmp_path: Path) -> None:
    soul = _make_soul(runtime, tmp_path)

    parts: list[ContentPart] = [
        TextPart(text="Focus on tests."),
        TextPart(text="Explain failures."),
    ]
    await soul._inject_steer(parts)

    message = soul.context.history[0]
    assert message.content == parts


@pytest.mark.asyncio
async def test_inject_steer_rejects_unsupported_media_and_keeps_context_clean(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    soul = _make_soul(_runtime_with_llm(runtime, _llm_with_capabilities(runtime, set())), tmp_path)

    with pytest.raises(LLMNotSupported):
        await soul._inject_steer(
            [ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/diagram.png"))]
        )

    assert soul.context.history == []


@pytest.mark.asyncio
async def test_consume_pending_steers_appends_history_before_emitting_wire_event(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[SteerInput] = []

    def fake_wire_send(msg) -> None:
        assert soul.context.history == [
            Message(role="user", content=[TextPart(text="Follow up now.")])
        ]
        assert isinstance(msg, SteerInput)
        sent.append(msg)

    monkeypatch.setattr(kimisoul_module, "wire_send", fake_wire_send)

    soul.steer("Follow up now.")

    assert await soul._consume_pending_steers() is True
    assert sent == [SteerInput(user_input="Follow up now.")]


@pytest.mark.asyncio
async def test_consume_pending_steers_does_not_emit_wire_event_for_unsupported_media(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(_runtime_with_llm(runtime, _llm_with_capabilities(runtime, set())), tmp_path)
    sent: list[SteerInput] = []
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    soul.steer(
        [ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/diagram.png"))]
    )

    with pytest.raises(LLMNotSupported):
        await soul._consume_pending_steers()

    assert sent == []
    assert soul.context.history == []


@pytest.mark.asyncio
async def test_consume_pending_steers_preserves_fifo_order_and_emits_matching_events(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[SteerInput] = []

    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    soul.steer("first")
    soul.steer("second")

    assert await soul._consume_pending_steers() is True
    assert soul.context.history == [
        Message(role="user", content=[TextPart(text="first")]),
        Message(role="user", content=[TextPart(text="second")]),
    ]
    assert sent == [SteerInput(user_input="first"), SteerInput(user_input="second")]


@pytest.mark.asyncio
async def test_agent_loop_injects_steer_between_completed_steps(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[object] = []
    step_calls = 0

    async def fake_fetch_request() -> None:
        await asyncio.Future()

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul._approval, "fetch_request", fake_fetch_request)
    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    async def fake_step():
        nonlocal step_calls
        step_calls += 1
        if step_calls == 1:
            await soul.context.append_message(
                Message(role="assistant", content=[TextPart(text="tool call finished")])
            )
            await soul.context.append_message(
                Message(
                    role="tool",
                    content=[TextPart(text="tool output")],
                    tool_call_id="call-1",
                )
            )
            soul.steer("follow-up steer")
            return None

        assert soul.context.history == [
            Message(role="assistant", content=[TextPart(text="tool call finished")]),
            Message(
                role="tool",
                content=[TextPart(text="tool output")],
                tool_call_id="call-1",
            ),
            Message(role="user", content=[TextPart(text="follow-up steer")]),
        ]
        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(role="assistant", content=[TextPart(text="done")]),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    outcome = await soul._agent_loop()

    assert outcome.stop_reason == "no_tool_calls"
    assert [msg for msg in sent if isinstance(msg, StepBegin)] == [StepBegin(n=1), StepBegin(n=2)]
    assert [msg for msg in sent if isinstance(msg, SteerInput)] == [
        SteerInput(user_input="follow-up steer")
    ]


@pytest.mark.asyncio
async def test_agent_loop_continues_after_tool_rejected_when_steer_is_injected(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[object] = []
    step_calls = 0

    async def fake_fetch_request() -> None:
        await asyncio.Future()

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul._approval, "fetch_request", fake_fetch_request)
    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    async def fake_step():
        nonlocal step_calls
        step_calls += 1
        if step_calls == 1:
            await soul.context.append_message(
                Message(role="assistant", content=[TextPart(text="plan blocked the tool call")])
            )
            await soul.context.append_message(
                Message(
                    role="tool",
                    content=[TextPart(text="<system>ERROR: rejected</system>")],
                    tool_call_id="call-1",
                )
            )
            soul.steer("switch to a read-only approach")
            return kimisoul_module.StepOutcome(
                stop_reason="tool_rejected",
                assistant_message=Message(
                    role="assistant",
                    content=[TextPart(text="plan blocked the tool call")],
                ),
            )

        assert soul.context.history == [
            Message(role="assistant", content=[TextPart(text="plan blocked the tool call")]),
            Message(
                role="tool",
                content=[TextPart(text="<system>ERROR: rejected</system>")],
                tool_call_id="call-1",
            ),
            Message(role="user", content=[TextPart(text="switch to a read-only approach")]),
        ]
        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(role="assistant", content=[TextPart(text="done")]),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    outcome = await soul._agent_loop()

    assert outcome.stop_reason == "no_tool_calls"
    assert [msg for msg in sent if isinstance(msg, StepBegin)] == [StepBegin(n=1), StepBegin(n=2)]
    assert [msg for msg in sent if isinstance(msg, SteerInput)] == [
        SteerInput(user_input="switch to a read-only approach")
    ]


@pytest.mark.asyncio
async def test_step_merges_plain_steer_with_dynamic_injection_in_model_history(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    captured_history: list[Message] = []

    await soul.context.append_message(
        [
            Message(role="user", content=[TextPart(text="Original question")]),
            Message(role="assistant", content=[TextPart(text="Original answer")]),
        ]
    )
    await soul._inject_steer("Follow user note")

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        captured_history[:] = list(history)
        return StepResult(
            id="step-1",
            message=Message(role="assistant", content=[TextPart(text="done")]),
            usage=None,
            tool_calls=[],
            _tool_result_futures={},
        )

    async def fake_collect_injections() -> list[DynamicInjection]:
        return [DynamicInjection(type="plan_mode", content="Internal reminder")]

    monkeypatch.setattr(
        soul,
        "_collect_injections",
        fake_collect_injections,
    )
    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    outcome = await soul._step()

    assert outcome is not None
    assert soul.context.history[-3:] == [
        Message(role="user", content=[TextPart(text="Follow user note")]),
        Message(
            role="user",
            content=[TextPart(text="<system-reminder>\nInternal reminder\n</system-reminder>")],
        ),
        Message(role="assistant", content=[TextPart(text="done")]),
    ]
    assert captured_history[-1].role == "user"
    assert captured_history[-1].content == [
        TextPart(text="Follow user note"),
        TextPart(text="<system-reminder>\nInternal reminder\n</system-reminder>"),
    ]


class _SequenceStreamedMessage:
    def __init__(self, parts: list[TextPart]) -> None:
        self._parts = list(parts)

    def __aiter__(self):
        return self

    async def __anext__(self) -> TextPart:
        if not self._parts:
            raise StopAsyncIteration
        return self._parts.pop(0)

    @property
    def id(self) -> str | None:
        return "sequence"

    @property
    def usage(self):
        return None


class _SequenceChatProvider:
    name = "sequence"

    def __init__(self, sequences: list[list[TextPart]]) -> None:
        self._sequences = [list(parts) for parts in sequences]
        self._calls = 0

    @property
    def model_name(self) -> str:
        return "sequence"

    @property
    def thinking_effort(self):
        return None

    async def generate(self, system_prompt, tools, history):
        index = min(self._calls, len(self._sequences) - 1)
        self._calls += 1
        return _SequenceStreamedMessage(self._sequences[index])

    def with_thinking(self, effort):
        return self


@pytest.mark.asyncio
async def test_run_soul_emits_steer_input_and_continues_same_turn(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    assert runtime.llm is not None
    llm = LLM(
        chat_provider=_SequenceChatProvider(
            [
                [TextPart(text="first answer")],
                [TextPart(text="second answer")],
            ]
        ),
        max_context_size=runtime.llm.max_context_size,
        capabilities=runtime.llm.capabilities,
    )
    agent = Agent(
        name="Steer Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=_runtime_with_llm(runtime, llm),
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    seen: list[object] = []
    injected = False

    async def ui_loop(wire: Wire) -> None:
        nonlocal injected
        wire_ui = wire.ui_side(merge=True)
        while True:
            try:
                msg = await wire_ui.receive()
            except QueueShutDown:
                return
            seen.append(msg)
            if not injected and msg == TextPart(text="first answer"):
                soul.steer("follow-up steer")
                injected = True

    await run_soul(soul, "original question", ui_loop, asyncio.Event())

    assert soul.context.history == [
        Message(role="user", content=[TextPart(text="original question")]),
        Message(role="assistant", content=[TextPart(text="first answer")]),
        Message(role="user", content=[TextPart(text="follow-up steer")]),
        Message(role="assistant", content=[TextPart(text="second answer")]),
    ]
    assert [msg for msg in seen if isinstance(msg, TurnBegin)] == [
        TurnBegin(user_input="original question")
    ]
    assert [msg for msg in seen if isinstance(msg, SteerInput)] == [
        SteerInput(user_input="follow-up steer")
    ]
    assert [msg for msg in seen if isinstance(msg, StepBegin)] == [StepBegin(n=1), StepBegin(n=2)]
    assert isinstance(seen[-1], TurnEnd)


def test_is_system_reminder_message_detects_internal_reminder_message() -> None:
    assert is_system_reminder_message(
        Message(
            role="user",
            content=[TextPart(text="<system-reminder>\nStay on task.\n</system-reminder>")],
        )
    )


def test_is_system_reminder_message_rejects_regular_user_message() -> None:
    assert (
        is_system_reminder_message(Message(role="user", content=[TextPart(text="hello")])) is False
    )
