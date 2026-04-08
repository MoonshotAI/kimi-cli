"""Tests for think-only response detection and auto-continuation.

When a model response contains only ThinkPart content (no TextPart, no tool_calls),
the agent loop should automatically continue instead of silently stopping.
This typically happens when thinking exhausts the max_tokens budget.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from kosong import StepResult
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import StepBegin, TextPart, ThinkPart


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Think-Only Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


@pytest.mark.asyncio
async def test_step_returns_none_for_think_only_response(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A think-only response (no text, no tool_calls) should return None to continue the loop."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        return StepResult(
            id="step-think-only",
            message=Message(
                role="assistant",
                content=[ThinkPart(think="I need to think about this deeply...")],
            ),
            usage=None,
            tool_calls=[],
            _tool_result_futures={},
        )

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    outcome = await soul._step()

    # think-only response should return None (continue loop), NOT a StepOutcome
    assert outcome is None


@pytest.mark.asyncio
async def test_step_injects_user_continuation_for_think_only(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After a think-only response, a user continuation message must be injected
    to maintain proper user->assistant message alternation in the context."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        return StepResult(
            id="step-think-only",
            message=Message(
                role="assistant",
                content=[ThinkPart(think="Deep thinking...")],
            ),
            usage=None,
            tool_calls=[],
            _tool_result_futures={},
        )

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    await soul._step()

    # Context should end with: assistant(think-only) followed by user(continuation).
    # (Dynamic injections may prepend additional user messages before the assistant.)
    history = soul.context.history
    assert len(history) >= 2

    # The second-to-last message must be the think-only assistant message
    assert history[-2].role == "assistant"
    assert all(isinstance(p, ThinkPart) for p in history[-2].content)

    # The last message must be the injected user continuation message
    assert history[-1].role == "user"
    assert len(history[-1].content) == 1
    assert isinstance(history[-1].content[0], TextPart)
    assert "<system>" in history[-1].content[0].text
    assert "continue" in history[-1].content[0].text.lower()


@pytest.mark.asyncio
async def test_step_returns_outcome_for_text_response(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A response with TextPart (even alongside ThinkPart) should stop normally."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        return StepResult(
            id="step-with-text",
            message=Message(
                role="assistant",
                content=[
                    ThinkPart(think="Let me think..."),
                    TextPart(text="Here is the answer."),
                ],
            ),
            usage=None,
            tool_calls=[],
            _tool_result_futures={},
        )

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    outcome = await soul._step()

    assert outcome is not None
    assert outcome.stop_reason == "no_tool_calls"


@pytest.mark.asyncio
async def test_agent_loop_continues_past_think_only_response(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The agent loop should continue when _step returns None for think-only, then stop on text."""
    soul = _make_soul(runtime, tmp_path)
    sent: list[object] = []
    step_calls = 0

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    async def fake_step():
        nonlocal step_calls
        step_calls += 1
        if step_calls == 1:
            # First step: think-only response (simulating max_tokens truncation)
            await soul.context.append_message(
                Message(
                    role="assistant",
                    content=[ThinkPart(think="Deep thinking that got truncated...")],
                )
            )
            return None  # continue loop
        # Second step: model completes with text
        return kimisoul_module.StepOutcome(
            stop_reason="no_tool_calls",
            assistant_message=Message(
                role="assistant", content=[TextPart(text="Here is the final answer.")]
            ),
        )

    monkeypatch.setattr(soul, "_step", fake_step)

    outcome = await soul._agent_loop()

    assert outcome.stop_reason == "no_tool_calls"
    assert step_calls == 2
    assert [msg for msg in sent if isinstance(msg, StepBegin)] == [StepBegin(n=1), StepBegin(n=2)]


@pytest.mark.asyncio
async def test_think_only_context_has_proper_message_alternation(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After think-only continuation, the context must alternate user/assistant properly:
    assistant(think-only) -> user(continuation) -> assistant(final response)."""
    soul = _make_soul(runtime, tmp_path)
    captured_histories: list[list[Message]] = []
    call_count = 0

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        nonlocal call_count
        call_count += 1
        captured_histories.append(list(history))

        if call_count == 1:
            return StepResult(
                id="step-think-only",
                message=Message(
                    role="assistant",
                    content=[ThinkPart(think="Truncated thinking...")],
                ),
                usage=None,
                tool_calls=[],
                _tool_result_futures={},
            )
        else:
            return StepResult(
                id="step-with-text",
                message=Message(
                    role="assistant",
                    content=[TextPart(text="Done.")],
                ),
                usage=None,
                tool_calls=[],
                _tool_result_futures={},
            )

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    outcome = await soul._agent_loop()

    assert outcome.stop_reason == "no_tool_calls"
    assert call_count == 2

    # Verify the second call's history has proper alternation:
    # assistant(think-only) -> user(continuation) -> [dynamic injection if any]
    second_history = captured_histories[1]

    # Find the think-only assistant message
    think_idx = next(
        i
        for i, m in enumerate(second_history)
        if m.role == "assistant"
        and any(isinstance(p, ThinkPart) for p in m.content)
        and not any(isinstance(p, TextPart) for p in m.content)
    )
    think_part = second_history[think_idx].content[0]
    assert isinstance(think_part, ThinkPart)
    assert think_part.think == "Truncated thinking..."

    # The message right after think-only must be a user message (continuation)
    continuation_msg = second_history[think_idx + 1]
    assert continuation_msg.role == "user"
    cont_part = continuation_msg.content[0]
    assert isinstance(cont_part, TextPart)
    assert "<system>" in cont_part.text

    # Final context after agent loop completes should also alternate properly
    final_history = soul.context.history
    roles = [m.role for m in final_history]
    for i in range(len(roles) - 1):
        if roles[i] == "assistant" and roles[i + 1] == "assistant":
            pytest.fail(
                f"Consecutive assistant messages at positions {i} and {i + 1}: "
                f"{final_history[i].content} / {final_history[i + 1].content}"
            )


@pytest.mark.asyncio
async def test_consecutive_think_only_responses(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Multiple consecutive think-only responses (simulating repeated max_tokens
    truncation) should all be handled gracefully until the model finally produces text."""
    soul = _make_soul(runtime, tmp_path)
    call_count = 0
    n_think_only = 3

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        nonlocal call_count
        call_count += 1

        if call_count <= n_think_only:
            return StepResult(
                id=f"step-think-{call_count}",
                message=Message(
                    role="assistant",
                    content=[ThinkPart(think=f"Thinking round {call_count}...")],
                ),
                usage=None,
                tool_calls=[],
                _tool_result_futures={},
            )
        else:
            return StepResult(
                id="step-final",
                message=Message(
                    role="assistant",
                    content=[TextPart(text="Final answer after extended thinking.")],
                ),
                usage=None,
                tool_calls=[],
                _tool_result_futures={},
            )

    async def fake_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    outcome = await soul._agent_loop()

    assert outcome.stop_reason == "no_tool_calls"
    assert call_count == n_think_only + 1  # 3 think-only + 1 final

    # Verify context has no consecutive assistant messages
    final_history = soul.context.history
    roles = [m.role for m in final_history]
    for i in range(len(roles) - 1):
        if roles[i] == "assistant" and roles[i + 1] == "assistant":
            pytest.fail(
                f"Consecutive assistant messages at positions {i} and {i + 1}: "
                f"{final_history[i].content} / {final_history[i + 1].content}"
            )

    # Each think-only assistant message should be followed by a user continuation
    think_indices = [
        i
        for i, m in enumerate(final_history)
        if m.role == "assistant"
        and any(isinstance(p, ThinkPart) for p in m.content)
        and not any(isinstance(p, TextPart) for p in m.content)
    ]
    assert len(think_indices) == n_think_only
    for idx in think_indices:
        assert idx + 1 < len(final_history)
        assert final_history[idx + 1].role == "user"


@pytest.mark.asyncio
@pytest.mark.parametrize("blank_text", ["", " \n\t "], ids=["empty", "whitespace"])
async def test_step_continues_for_think_with_empty_text(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    blank_text: str,
) -> None:
    """ThinkPart + empty/whitespace TextPart should still be treated as think-only."""
    soul = _make_soul(runtime, tmp_path)

    async def fake_kosong_step(chat_provider, system_prompt, toolset, history, **kwargs):
        return StepResult(
            id="step-think-empty-text",
            message=Message(
                role="assistant",
                content=[
                    ThinkPart(think="Thinking hard..."),
                    TextPart(text=blank_text),
                ],
            ),
            usage=None,
            tool_calls=[],
            _tool_result_futures={},
        )

    monkeypatch.setattr(kimisoul_module.kosong, "step", fake_kosong_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    outcome = await soul._step()

    # Empty/whitespace TextPart should not prevent think-only detection
    assert outcome is None
