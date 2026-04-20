from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from kosong.message import ImageURLPart
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import StepBegin, StepInterrupted, TextPart, TurnBegin, TurnEnd


@pytest.fixture
def approval() -> Approval:
    """Override global yolo=True fixture; these tests only need wire semantics."""
    return Approval(yolo=False)


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Turn Balance Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


@pytest.mark.asyncio
async def test_run_emits_turn_end_when_step_interrupts(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[object] = []

    async def fake_checkpoint() -> None:
        return None

    async def fake_step():
        raise RuntimeError("boom")

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(soul, "_step", fake_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    with pytest.raises(RuntimeError, match="boom"):
        await soul.run("hello")

    assert [msg for msg in sent if isinstance(msg, TurnBegin)] == [TurnBegin(user_input="hello")]
    assert [msg for msg in sent if isinstance(msg, StepBegin)] == [StepBegin(n=1)]
    assert [msg for msg in sent if isinstance(msg, StepInterrupted)] == [StepInterrupted()]
    assert [msg for msg in sent if isinstance(msg, TurnEnd)] == [TurnEnd()]
    assert isinstance(sent[-1], TurnEnd)


@pytest.mark.asyncio
async def test_run_emits_turn_end_on_cancelled_error(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[object] = []

    async def fake_checkpoint() -> None:
        return None

    async def fake_step():
        raise asyncio.CancelledError()

    monkeypatch.setattr(soul, "_checkpoint", fake_checkpoint)
    monkeypatch.setattr(soul._denwa_renji, "set_n_checkpoints", lambda _n: None)
    monkeypatch.setattr(soul, "_step", fake_step)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    with pytest.raises(asyncio.CancelledError):
        await soul.run("hello")

    assert [msg for msg in sent if isinstance(msg, TurnBegin)] == [TurnBegin(user_input="hello")]
    assert [msg for msg in sent if isinstance(msg, StepBegin)] == [StepBegin(n=1)]
    assert [msg for msg in sent if isinstance(msg, StepInterrupted)] == []
    assert [msg for msg in sent if isinstance(msg, TurnEnd)] == [TurnEnd()]
    assert isinstance(sent[-1], TurnEnd)


@pytest.mark.asyncio
async def test_run_does_not_duplicate_turn_end_for_blocked_prompt(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[object] = []

    async def fake_trigger(*args, **kwargs):
        return [SimpleNamespace(action="block", reason="blocked by hook")]

    monkeypatch.setattr(soul._hook_engine, "trigger", fake_trigger)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda msg: sent.append(msg))

    await soul.run("hello")

    assert sent == [
        TurnBegin(user_input="hello"),
        TextPart(text="blocked by hook"),
        TurnEnd(),
    ]


@pytest.mark.asyncio
async def test_run_extracts_text_parts_for_user_prompt_submit_hook(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    seen_prompt: str | None = None

    async def fake_trigger(_event: str, **kwargs):
        nonlocal seen_prompt
        seen_prompt = kwargs["input_data"]["prompt"]
        return [SimpleNamespace(action="block", reason="blocked by hook")]

    monkeypatch.setattr(soul._hook_engine, "trigger", fake_trigger)
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    await soul.run(
        [
            TextPart(text="Check this image"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/test.png")),
            TextPart(text="And summarize it"),
        ]
    )

    assert seen_prompt == "Check this image\nAnd summarize it"
