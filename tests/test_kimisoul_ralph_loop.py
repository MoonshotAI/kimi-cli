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
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import RALPH_SAFEWORD, KimiSoul
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.types import TurnBegin

T = TypeVar("T")
RALPH_LOOP_SYSTEM_TEXT = (
    "<system>You are running in an automated loop where the same prompt is fed repeatedly. "
    "Only include the safeword when the task is fully complete: <safeword>STOP</safeword>. "
    "Including it will stop further iterations.</system>"
)
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
        skills=runtime.skills,
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
async def test_ralph_loop_replays_original_prompt(runtime: Runtime, tmp_path: Path) -> None:
    runtime.config.loop_control.max_ralph_iterations = 2

    user_input = RALPH_IMAGE_USER_INPUT
    llm = _make_llm(
        [
            [TextPart(text="first")],
            [TextPart(text="second")],
            [TextPart(text="third")],
        ],
        {"image_in"},
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    await _run_and_collect_turns(soul, user_input)
    expect_snapshot(
        context.history,
        snapshot(
            [
                Message(
                    role="user",
                    content=[
                        TextPart(text="Check this image"),
                        ImageURLPart(
                            image_url=ImageURLPart.ImageURL(url="https://example.com/test.png")
                        ),
                        TextPart(text=RALPH_LOOP_SYSTEM_TEXT),
                    ],
                ),
                Message(role="assistant", content=[TextPart(text="first")]),
                Message(
                    role="user",
                    content=[
                        TextPart(text="Check this image"),
                        ImageURLPart(
                            image_url=ImageURLPart.ImageURL(url="https://example.com/test.png")
                        ),
                        TextPart(text=RALPH_LOOP_SYSTEM_TEXT),
                    ],
                ),
                Message(role="assistant", content=[TextPart(text="second")]),
                Message(
                    role="user",
                    content=[
                        TextPart(text="Check this image"),
                        ImageURLPart(
                            image_url=ImageURLPart.ImageURL(url="https://example.com/test.png")
                        ),
                        TextPart(text=RALPH_LOOP_SYSTEM_TEXT),
                    ],
                ),
                Message(role="assistant", content=[TextPart(text="third")]),
            ]
        ),
    )


@pytest.mark.asyncio
async def test_ralph_loop_stops_on_safeword(runtime: Runtime, tmp_path: Path) -> None:
    runtime.config.loop_control.max_ralph_iterations = -1

    llm = _make_llm(
        [
            [TextPart(text="first")],
            [TextPart(text=f"done {RALPH_SAFEWORD}")],
        ],
        set(),
    )

    toolset = SimpleToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    await _run_and_collect_turns(soul, "do it")
    expect_snapshot(
        context.history,
        snapshot(
            [
                Message(
                    role="user",
                    content=[
                        TextPart(text="do it"),
                        TextPart(text=RALPH_LOOP_SYSTEM_TEXT),
                    ],
                ),
                Message(role="assistant", content=[TextPart(text="first")]),
                Message(
                    role="user",
                    content=[
                        TextPart(text="do it"),
                        TextPart(text=RALPH_LOOP_SYSTEM_TEXT),
                    ],
                ),
                Message(
                    role="assistant", content=[TextPart(text="done <safeword>STOP</safeword>")]
                ),
            ]
        ),
    )


@pytest.mark.asyncio
async def test_ralph_loop_stops_on_tool_rejected(runtime: Runtime, tmp_path: Path) -> None:
    runtime.config.loop_control.max_ralph_iterations = 3

    llm = _make_llm(
        [
            [
                ToolCall(
                    id="call-1",
                    function=ToolCall.FunctionBody(name="reject_tool", arguments="{}"),
                )
            ],
        ],
        set(),
    )

    toolset = RejectToolset()
    soul, context = _make_soul(runtime, llm, toolset, tmp_path)

    await _run_and_collect_turns(soul, "do it")
    expect_snapshot(
        context.history,
        snapshot(
            [
                Message(
                    role="user",
                    content=[
                        TextPart(text="do it"),
                        TextPart(text=RALPH_LOOP_SYSTEM_TEXT),
                    ],
                ),
                Message(
                    role="assistant",
                    content=[],
                    tool_calls=[
                        ToolCall(
                            id="call-1",
                            function=ToolCall.FunctionBody(name="reject_tool", arguments="{}"),
                        )
                    ],
                ),
                Message(
                    role="tool",
                    content=[
                        TextPart(
                            text=(
                                "<system>ERROR: The tool call is rejected by the user. "
                                "Please follow the new instructions from the user.</system>"
                            )
                        )
                    ],
                    tool_call_id="call-1",
                ),
            ]
        ),
    )


@pytest.mark.asyncio
async def test_ralph_loop_disabled_skips_safeword_prompt(runtime: Runtime, tmp_path: Path) -> None:
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
