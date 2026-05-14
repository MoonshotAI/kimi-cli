from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from kosong import StepCancelled, StepResult
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import INTERRUPTED_TOOL_MESSAGE, KimiSoul
from kimi_cli.wire.types import TextPart, ToolCall, ToolResult


@pytest.mark.asyncio
async def test_cancel_during_tool_results_records_interrupted_tool_result(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = Agent(
        name="Tool Interrupt Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    sent: list[Any] = []
    pending_future_ready = asyncio.Event()

    async def fake_step(
        _chat_provider: Any,
        _system_prompt: str,
        _toolset: Any,
        _history: Any,
        *,
        on_message_part: Any = None,
        on_tool_result: Any = None,
    ) -> StepResult:
        del on_tool_result
        tool_call = ToolCall(
            id="tc-interrupted",
            function=ToolCall.FunctionBody(name="SlowTool", arguments='{"seconds": 30}'),
        )
        if on_message_part is not None:
            on_message_part(TextPart(text="I will run the slow tool."))
            on_message_part(tool_call)
        pending_future: asyncio.Future[ToolResult] = asyncio.get_running_loop().create_future()
        pending_future_ready.set()
        return StepResult(
            "msg-interrupted",
            Message(
                role="assistant",
                content=[TextPart(text="I will run the slow tool.")],
                tool_calls=[tool_call],
            ),
            None,
            [tool_call],
            {tool_call.id: pending_future},
        )

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    task = asyncio.create_task(soul.run("run a slow tool"))
    await asyncio.wait_for(pending_future_ready.wait(), timeout=1.0)
    await asyncio.sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    history = list(soul.context.history)
    assistant_messages = [message for message in history if message.role == "assistant"]
    tool_messages = [message for message in history if message.role == "tool"]

    assert assistant_messages
    assert assistant_messages[-1].tool_calls
    assert assistant_messages[-1].tool_calls[0].id == "tc-interrupted"
    assert tool_messages
    assert tool_messages[-1].tool_call_id == "tc-interrupted"
    assert INTERRUPTED_TOOL_MESSAGE in tool_messages[-1].extract_text()

    interrupted_wire_results = [
        msg for msg in sent if isinstance(msg, ToolResult) and msg.tool_call_id == "tc-interrupted"
    ]
    assert interrupted_wire_results
    assert interrupted_wire_results[-1].return_value.is_error is True
    assert interrupted_wire_results[-1].return_value.brief == ""


@pytest.mark.asyncio
async def test_interrupted_tool_result_is_sent_to_next_model_step(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = Agent(
        name="Tool Interrupt Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    pending_future_ready = asyncio.Event()
    captured_next_history: list[Message] = []
    step_calls = 0

    async def fake_step(
        _chat_provider: Any,
        _system_prompt: str,
        _toolset: Any,
        history: list[Message],
        *,
        on_message_part: Any = None,
        on_tool_result: Any = None,
    ) -> StepResult:
        nonlocal step_calls, captured_next_history
        del on_tool_result
        step_calls += 1
        if step_calls == 2:
            captured_next_history = list(history)
            return StepResult(
                "msg-next",
                Message(role="assistant", content="I can see the interrupt marker."),
                None,
                [],
                {},
            )

        tool_call = ToolCall(
            id="tc-interrupted",
            function=ToolCall.FunctionBody(name="SlowTool", arguments='{"seconds": 30}'),
        )
        if on_message_part is not None:
            on_message_part(TextPart(text="I will run the slow tool."))
            on_message_part(tool_call)
        pending_future: asyncio.Future[ToolResult] = asyncio.get_running_loop().create_future()
        pending_future_ready.set()
        return StepResult(
            "msg-interrupted",
            Message(
                role="assistant",
                content=[TextPart(text="I will run the slow tool.")],
                tool_calls=[tool_call],
            ),
            None,
            [tool_call],
            {tool_call.id: pending_future},
        )

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    interrupted_task = asyncio.create_task(soul.run("run a slow tool"))
    await asyncio.wait_for(pending_future_ready.wait(), timeout=1.0)
    await asyncio.sleep(0)

    interrupted_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await interrupted_task

    await soul.run("can you see my cancel?")

    assert any(
        message.role == "assistant"
        and message.tool_calls
        and message.tool_calls[0].id == "tc-interrupted"
        for message in captured_next_history
    )
    assert any(
        message.role == "tool"
        and message.tool_call_id == "tc-interrupted"
        and INTERRUPTED_TOOL_MESSAGE in message.extract_text()
        for message in captured_next_history
    )


@pytest.mark.asyncio
async def test_streaming_phase_cancel_persists_assistant_with_interrupted_tool_result(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ESC during LLM streaming (after a tool_call became visible in the TUI)
    must still leave history well-formed: the assistant message is appended
    AND every visible tool_call is paired with a synthetic [Interrupted]
    tool_result.

    This is the "thinking + tool-call" case from the bug report: the model
    streams a tool_call to the UI, the user presses ESC before the stream
    finishes, kosong.step() never returns a complete StepResult — and the
    previous implementation lost the entire assistant message.
    """
    agent = Agent(
        name="Tool Interrupt Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    sent: list[Any] = []
    streaming_started = asyncio.Event()

    async def fake_step(
        _chat_provider: Any,
        _system_prompt: str,
        _toolset: Any,
        _history: Any,
        *,
        on_message_part: Any = None,
        on_tool_result: Any = None,
    ) -> StepResult:
        del on_tool_result
        # emit a tool_call to the wire — UI now sees it
        tool_call = ToolCall(
            id="tc-streamed",
            function=ToolCall.FunctionBody(name="SlowTool", arguments="{}"),
        )
        if on_message_part is not None:
            on_message_part(TextPart(text="thinking about it..."))
            on_message_part(tool_call)
        streaming_started.set()
        # Block until cancelled — mirroring real kosong behaviour, transform
        # the incoming CancelledError into a StepCancelled carrying the
        # partial StepResult so the caller can pair tool_calls with synthetic
        # results.  No futures because on_tool_call would have started the
        # tool, which we explicitly skip in the cancel path.
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            partial = StepResult(
                id=None,
                message=Message(
                    role="assistant",
                    content=[TextPart(text="thinking about it...")],
                    tool_calls=[tool_call],
                ),
                usage=None,
                tool_calls=[tool_call],
                _tool_result_futures={},
            )
            raise StepCancelled(partial) from None
        raise AssertionError("unreachable")  # pragma: no cover

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    task = asyncio.create_task(soul.run("call the slow tool"))
    await asyncio.wait_for(streaming_started.wait(), timeout=1.0)
    await asyncio.sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    history = list(soul.context.history)
    assistant_messages = [m for m in history if m.role == "assistant"]
    tool_messages = [m for m in history if m.role == "tool"]

    assert assistant_messages, "assistant message must be persisted even on streaming cancel"
    assert assistant_messages[-1].tool_calls
    assert assistant_messages[-1].tool_calls[0].id == "tc-streamed"
    assert tool_messages, "interrupted tool_result must be persisted to pair the tool_call"
    assert tool_messages[-1].tool_call_id == "tc-streamed"
    assert INTERRUPTED_TOOL_MESSAGE in tool_messages[-1].extract_text()

    interrupted_wire_results = [
        msg for msg in sent if isinstance(msg, ToolResult) and msg.tool_call_id == "tc-streamed"
    ]
    assert interrupted_wire_results
    assert interrupted_wire_results[-1].return_value.is_error is True
    assert interrupted_wire_results[-1].return_value.brief == ""
