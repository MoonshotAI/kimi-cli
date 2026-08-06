"""Tests for capability handling of media in tool results during _grow_context (#2588)."""

from __future__ import annotations

from pathlib import Path

import pytest
from kosong import StepResult
from kosong.message import Message
from kosong.tooling import ToolOk
from kosong.tooling.empty import EmptyToolset

from kimi_cli.llm import LLM, ModelCapability
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import ImageURLPart, TextPart, ToolResult


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Grow Context Media Test Agent",
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
        notifications=runtime.notifications,
        background_tasks=runtime.background_tasks,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
        skills_dirs=runtime.skills_dirs,
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
async def test_grow_context_omits_image_when_model_lacks_image_in(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(_runtime_with_llm(runtime, _llm_with_capabilities(runtime, set())), tmp_path)

    await soul.context.append_message(Message(role="user", content=[TextPart(text="edit doc")]))
    await soul.context.append_message(
        Message(role="assistant", content=[TextPart(text="edited successfully")])
    )

    img = ImageURLPart(image_url=ImageURLPart.ImageURL(url="data:image/png;base64,AAA"))
    tool_results = [
        ToolResult(
            tool_call_id="call_screenshot",
            return_value=ToolOk(message="screenshot captured", output=img),
        )
    ]
    step = StepResult(
        id="step1",
        message=Message(role="assistant", content=[TextPart(text="taking screenshot")]),
        usage=None,
        tool_calls=[],
        _tool_result_futures={},
    )

    await soul._grow_context(step, tool_results)

    # Prior side effects remain, and the turn continues with a text stand-in.
    assert len(soul.context.history) == 4
    tool_msg = soul.context.history[-1]
    assert tool_msg.role == "tool"
    assert tool_msg.tool_call_id == "call_screenshot"
    assert not any(isinstance(part, ImageURLPart) for part in tool_msg.content)
    assert any(
        isinstance(part, TextPart) and "Image omitted" in part.text for part in tool_msg.content
    )


@pytest.mark.asyncio
async def test_grow_context_keeps_image_when_model_has_image_in(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(
        _runtime_with_llm(runtime, _llm_with_capabilities(runtime, {"image_in"})),
        tmp_path,
    )

    img = ImageURLPart(image_url=ImageURLPart.ImageURL(url="data:image/png;base64,AAA"))
    tool_results = [
        ToolResult(
            tool_call_id="call_screenshot",
            return_value=ToolOk(message="screenshot captured", output=img),
        )
    ]
    step = StepResult(
        id="step1",
        message=Message(role="assistant", content=[TextPart(text="taking screenshot")]),
        usage=None,
        tool_calls=[],
        _tool_result_futures={},
    )

    await soul._grow_context(step, tool_results)

    tool_msg = soul.context.history[-1]
    assert any(isinstance(part, ImageURLPart) for part in tool_msg.content)
