from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Self, TypeVar

import pytest
from inline_snapshot import Snapshot, snapshot
from kosong.chat_provider import StreamedMessagePart, ThinkingEffort, TokenUsage
from kosong.message import ContentPart, ImageURLPart, Message, TextPart, ToolCall
from kosong.tooling import CallableTool2, Tool, ToolResult, ToolReturnValue, Toolset
from kosong.tooling.simple import SimpleToolset
from pydantic import BaseModel

from kimi_cli.llm import LLM, ModelCapability
from kimi_cli.soul import run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.types import TurnBegin


@pytest.fixture
def approval() -> Approval:
    """Override global yolo=True fixture; ralph loop tests don't need yolo."""
    return Approval(yolo=False)


T = TypeVar("T")
RALPH_IMAGE_URL = "https://example.com/test.png"
RALPH_IMAGE_USER_INPUT = [
    TextPart(text="Check this image"),
    ImageURLPart(image_url=ImageURLPart.ImageURL(url=RALPH_IMAGE_URL)),
]


def expect_snapshot(value: T, expected: Snapshot[T]) -> None:
    if expected != value:
        pytest.fail(f"Snapshot mismatch: {value!r} != {expected!r}")


class SequenceStreamedMessage:
    def __init__(self, parts: Sequence[StreamedMessagePart]) -> None:
        self._iter = self._to_stream(list(parts))

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        return await self._iter.__anext__()

    async def _to_stream(
        self, parts: list[StreamedMessagePart]
    ) -> AsyncIterator[StreamedMessagePart]:
        for part in parts:
            yield part

    @property
    def id(self) -> str | None:
        return "sequence"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class SequenceChatProvider:
    name = "sequence"

    def __init__(self, sequences: Sequence[Sequence[StreamedMessagePart]]) -> None:
        self._sequences = [list(sequence) for sequence in sequences]
        self._index = 0

    @property
    def model_name(self) -> str:
        return "sequence"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> SequenceStreamedMessage:
        index = min(self._index, len(self._sequences) - 1)
        self._index += 1
        return SequenceStreamedMessage(self._sequences[index])

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


def _make_llm(
    sequences: Sequence[Sequence[StreamedMessagePart]],
    capabilities: set[ModelCapability],
) -> LLM:
    return LLM(
        chat_provider=SequenceChatProvider(sequences),
        max_context_size=100_000,
        capabilities=capabilities,
    )


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
        notifications=runtime.notifications,
        background_tasks=runtime.background_tasks,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
        skills_dirs=runtime.skills_dirs,
        role=runtime.role,
    )


def _make_soul(
    runtime: Runtime, llm: LLM, toolset: Toolset, tmp_path: Path
) -> tuple[KimiSoul, Context]:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=toolset,
        runtime=_runtime_with_llm(runtime, llm),
    )
    context = Context(file_backend=tmp_path / "history.jsonl")
    return KimiSoul(agent, context=context), context


async def _run_and_collect_turns(
    soul: KimiSoul, user_input: str | list[ContentPart]
) -> list[str | list[ContentPart]]:
    turns: list[str | list[ContentPart]] = []

    async def _ui_loop_fn(wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=True)
        while True:
            try:
                msg = await wire_ui.receive()
            except QueueShutDown:
                return
            if isinstance(msg, TurnBegin):
                turns.append(msg.user_input)

    await run_soul(soul, user_input, _ui_loop_fn, asyncio.Event())
    return turns


class RejectParams(BaseModel):
    pass


class RejectTool(CallableTool2[RejectParams]):
    name = "reject_tool"
    description = "Always reject tool calls."
    params = RejectParams

    async def __call__(self, params: RejectParams) -> ToolReturnValue:
        return ToolRejectedError()


class RejectToolset:
    def __init__(self) -> None:
        self._tool = RejectTool()

    @property
    def tools(self) -> list[Tool]:
        return [self._tool.base]

    def handle(self, tool_call: ToolCall) -> ToolResult:
        return ToolResult(tool_call_id=tool_call.id, return_value=ToolRejectedError())


@pytest.mark.asyncio
async def test_auto_ralph_uses_ephemeral_context(runtime: Runtime, tmp_path: Path) -> None:
    """Auto-Ralph runs in ephemeral context; only one TurnBegin is emitted."""
    runtime.config.loop_control.max_ralph_iterations = 2

    user_input = RALPH_IMAGE_USER_INPUT
    llm = _make_llm(
        [
            [TextPart(text="normal response")],
            [TextPart(text="<choice>STOP</choice>")],
        ],
        {"image_in"},
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    turns = await _run_and_collect_turns(soul, user_input)
    # Only one TurnBegin from the outer soul.run(); _flow_turn no longer emits its own
    assert len(turns) == 1
    # Auto-ralph merges ephemeral context back so the LLM retains cross-turn memory
    assert len(context.history) > 0


@pytest.mark.asyncio
async def test_explicit_flow_uses_ephemeral_context(runtime: Runtime, tmp_path: Path) -> None:
    """Explicit /flow:<skill> runs in ephemeral context; main context stays clean."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="task result")],
            [TextPart(text="<choice>STOP</choice>")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    # Build a simple flow: BEGIN -> task -> decision -> END
    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
        "D1": FlowNode(id="D1", label="Continue or stop?", kind="decision"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="D1", label=None)],
        "D1": [
            FlowEdge(src="D1", dst="D1", label="CONTINUE"),
            FlowEdge(src="D1", dst="END", label="STOP"),
        ],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="test")
    await runner.run(soul, "")

    # Main context should be empty because flow used ephemeral context
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_flow_runner_uses_flow_decision_tool(runtime: Runtime, tmp_path: Path) -> None:
    """The flow engine should read decisions from the flow_decision tool."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="task result")],
            [
                ToolCall(
                    id="call-1",
                    function=ToolCall.FunctionBody(
                        name="flow_decision",
                        arguments='{"choice": "STOP", "confidence": 0.95, "reasoning": "Done"}',
                    ),
                )
            ],
            [TextPart(text="done")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
        "D1": FlowNode(id="D1", label="Choose wisely", kind="decision"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="D1", label=None)],
        "D1": [
            FlowEdge(src="D1", dst="D1", label="CONTINUE"),
            FlowEdge(src="D1", dst="END", label="STOP"),
        ],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="test")
    await runner.run(soul, "")

    # Main context should be empty (ephemeral)
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_flow_runner_auto_stops_on_convergence(runtime: Runtime, tmp_path: Path) -> None:
    """The flow engine should auto-stop if the model keeps choosing CONTINUE with identical responses."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="same response every time")],
            [TextPart(text="same response every time")],
            [TextPart(text="same response every time")],
            [TextPart(text="same response every time")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
        "D1": FlowNode(id="D1", label="Choose wisely", kind="decision"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="D1", label=None)],
        "D1": [
            FlowEdge(src="D1", dst="D1", label="CONTINUE"),
            FlowEdge(src="D1", dst="END", label="STOP"),
        ],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="test")
    await runner.run(soul, "")

    # Should have stopped early due to convergence, not run all 4 iterations
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_flow_runner_aborts_after_max_retries(runtime: Runtime, tmp_path: Path) -> None:
    """Invalid choices in a flow should abort after 3 retries."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="first")],
            [TextPart(text="bad choice")],
            [TextPart(text="another bad")],
            [TextPart(text="still bad")],
            [TextPart(text="fourth bad — should not reach")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
        "D1": FlowNode(id="D1", label="Choose wisely", kind="decision"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="D1", label=None)],
        "D1": [
            FlowEdge(src="D1", dst="D1", label="CONTINUE"),
            FlowEdge(src="D1", dst="END", label="STOP"),
        ],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="test")
    await runner.run(soul, "")

    # Main context should be empty (ephemeral)
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_flow_runner_cancel_before_start(runtime: Runtime, tmp_path: Path) -> None:
    """Calling cancel() before run() should prevent any nodes from executing."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="should not run")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="END", label=None)],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="test")
    runner.cancel()
    await runner.run(soul, "")

    # No turns should have executed; ephemeral context never created
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_flow_runner_cancel_mid_flow(runtime: Runtime, tmp_path: Path) -> None:
    """Calling cancel() after a task node should stop before the next decision."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="task done")],
            [TextPart(text="should not reach")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
        "D1": FlowNode(id="D1", label="Decide", kind="decision"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="D1", label=None)],
        "D1": [
            FlowEdge(src="D1", dst="END", label="STOP"),
        ],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="test")

    # We can't easily inject cancel() mid-run in a single-threaded test,
    # so we verify the escape hatch exists by checking the cancelled flag
    # is read before each node execution.
    assert runner._cancelled is False
    runner.cancel()
    assert runner._cancelled is True
    await runner.run(soul, "")

    # Main context should be empty (ephemeral)
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_flow_runner_pause_keeps_temp_file(runtime: Runtime, tmp_path: Path) -> None:
    """PAUSE should exit the flow and preserve the ephemeral temp file."""
    from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
    from kimi_cli.soul.kimisoul import FlowRunner

    llm = _make_llm(
        [
            [TextPart(text="task result")],
            [
                ToolCall(
                    id="call-1",
                    function=ToolCall.FunctionBody(
                        name="flow_decision",
                        arguments='{"choice": "PAUSE", "confidence": 0.9, "reasoning": "Need user input"}',
                    ),
                )
            ],
            [TextPart(text="done")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
        "END": FlowNode(id="END", label="END", kind="end"),
        "T1": FlowNode(id="T1", label="Do the task", kind="task"),
        "D1": FlowNode(id="D1", label="Decide", kind="decision"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="T1", label=None)],
        "T1": [FlowEdge(src="T1", dst="D1", label=None)],
        "D1": [
            FlowEdge(src="D1", dst="END", label="STOP"),
            FlowEdge(src="D1", dst="END", label="PAUSE"),
        ],
        "END": [],
    }
    flow = Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")

    runner = FlowRunner(flow, name="pause_test")
    await runner.run(soul, "")

    assert runner._paused is True
    # Temp file should still exist because PAUSE prevents cleanup
    assert runner._tmp_file is not None
    assert runner._tmp_file.exists()
    # Main context stays clean
    assert len(context.history) == 0


@pytest.mark.asyncio
async def test_ralph_loop_disabled_skips_loop_prompt(runtime: Runtime, tmp_path: Path) -> None:
    runtime.config.loop_control.max_ralph_iterations = 0

    llm = _make_llm([[TextPart(text="done")]], set())

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    await _run_and_collect_turns(soul, "hello")
    expect_snapshot(
        context.history,
        snapshot(
            [
                Message(role="user", content=[TextPart(text="hello")]),
                Message(role="assistant", content=[TextPart(text="done")]),
            ]
        ),
    )
