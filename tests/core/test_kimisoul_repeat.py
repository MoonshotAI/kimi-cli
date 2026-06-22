from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Self

import pytest
from kosong.chat_provider import StreamedMessagePart, ThinkingEffort, TokenUsage
from kosong.message import Message, ToolCall
from kosong.tooling import CallableTool2, Tool, ToolOk, ToolReturnValue
from pydantic import BaseModel

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.llm import LLM
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset


class _Params(BaseModel):
    value: str = ""


class _DummyTool(CallableTool2[_Params]):
    name = "ToolA"
    description = "Dummy tool that always succeeds."
    params = _Params

    async def __call__(self, params: _Params) -> ToolReturnValue:
        return ToolOk(output="a")


class _RepeatStream:
    def __init__(self, parts: list[StreamedMessagePart]) -> None:
        self._iter = self._to_stream(parts)

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
        return "repeat"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class _RepeatChatProvider:
    name = "repeat"

    def __init__(self) -> None:
        self._n = 0

    @property
    def model_name(self) -> str:
        return "repeat"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> _RepeatStream:
        self._n += 1
        tc = ToolCall(
            id=f"tc-{self._n}",
            function=ToolCall.FunctionBody(name="ToolA", arguments='{"value":"x"}'),
        )
        return _RepeatStream([tc])

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
        notifications=runtime.notifications,
        background_tasks=runtime.background_tasks,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
        skills_dirs=runtime.skills_dirs,
        role=runtime.role,
    )


def _make_soul(runtime: Runtime, llm: LLM, toolset: KimiToolset, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Repeat Test Agent",
        system_prompt="Test system prompt.",
        toolset=toolset,
        runtime=_runtime_with_llm(runtime, llm),
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


@pytest.mark.asyncio
async def test_turn_force_stops_after_twelve_identical_calls(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    toolset = KimiToolset()
    toolset.add(_DummyTool())
    llm = LLM(
        chat_provider=_RepeatChatProvider(),
        max_context_size=100_000,
        capabilities=set(),
    )
    soul = _make_soul(runtime, llm, toolset, tmp_path)

    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    async def _noop_checkpoint() -> None:
        return None

    monkeypatch.setattr(soul, "_checkpoint", _noop_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)

    outcome = await soul._turn(Message(role="user", content="go"))

    assert outcome.stop_reason == "tool_call_repeat"
    assert outcome.step_count == 12
