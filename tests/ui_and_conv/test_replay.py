from __future__ import annotations

from pathlib import Path

import pytest
from kosong.message import Message

import kimi_cli.ui.shell.replay as replay_module
from kimi_cli.soul.message import system_reminder
from kimi_cli.ui.shell.replay import (
    _build_replay_turns_from_history,
    _build_replay_turns_from_wire,
    replay_recent_history,
)
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire.file import WireFile
from kimi_cli.wire.types import SteerInput, StepBegin, TextPart, TurnBegin


def test_build_replay_turns_from_history_ignores_system_reminders() -> None:
    history = [
        Message(role="user", content=[TextPart(text="Original question")]),
        Message(role="assistant", content=[TextPart(text="First answer")]),
        Message(role="user", content=[system_reminder("Do not create a new turn.")]),
        Message(role="assistant", content=[TextPart(text="Follow-up answer")]),
    ]

    turns = _build_replay_turns_from_history(history)

    assert len(turns) == 1
    assert turns[0].user_message.extract_text(" ") == "Original question"
    assert turns[0].n_steps == 2


def test_build_replay_turns_from_history_keeps_plain_steer_as_user_turn() -> None:
    history = [
        Message(role="user", content=[TextPart(text="Original question")]),
        Message(role="assistant", content=[TextPart(text="First answer")]),
        Message(role="user", content=[TextPart(text="A steer follow-up")]),
        Message(role="assistant", content=[TextPart(text="Follow-up answer")]),
    ]

    turns = _build_replay_turns_from_history(history)

    assert len(turns) == 2
    assert turns[0].user_message.extract_text(" ") == "Original question"
    assert turns[1].user_message.extract_text(" ") == "A steer follow-up"


@pytest.mark.asyncio
async def test_build_replay_turns_from_wire_keeps_steer_as_user_turn(tmp_path: Path) -> None:
    wire_file = WireFile(tmp_path / "wire.jsonl")
    await wire_file.append_message(TurnBegin(user_input=[TextPart(text="Original question")]))
    await wire_file.append_message(StepBegin(n=1))
    await wire_file.append_message(TextPart(text="First answer"))
    await wire_file.append_message(SteerInput(user_input=[TextPart(text="A steer follow-up")]))
    await wire_file.append_message(StepBegin(n=2))
    await wire_file.append_message(TextPart(text="Follow-up answer"))

    turns = await _build_replay_turns_from_wire(wire_file)

    assert len(turns) == 2
    assert turns[0].user_message.extract_text(" ") == "Original question"
    assert turns[0].n_steps == 1
    assert turns[1].user_message.extract_text(" ") == "A steer follow-up"
    assert turns[1].n_steps == 2


@pytest.mark.asyncio
async def test_replay_recent_history_falls_back_to_history_when_wire_misses_steer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    history = [
        Message(role="user", content=[TextPart(text="Original question")]),
        Message(role="assistant", content=[TextPart(text="First answer")]),
        Message(role="user", content=[TextPart(text="A steer follow-up")]),
        Message(role="assistant", content=[TextPart(text="Follow-up answer")]),
    ]
    wire_file = WireFile(tmp_path / "wire.jsonl")
    await wire_file.append_message(TurnBegin(user_input=[TextPart(text="Original question")]))
    await wire_file.append_message(StepBegin(n=1))
    await wire_file.append_message(TextPart(text="First answer"))

    printed: list[str] = []
    monkeypatch.setattr(
        replay_module.console,
        "print",
        lambda text: printed.append(getattr(text, "plain", str(text))),
    )

    async def fake_visualize(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(replay_module, "visualize", fake_visualize)

    await replay_recent_history(history, wire_file=wire_file)

    assert printed == ["✨ Original question", "✨ A steer follow-up"]


@pytest.mark.asyncio
async def test_replay_recent_history_prefers_wire_when_turns_match(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    history = [
        Message(role="user", content=[TextPart(text="Original question")]),
        Message(role="assistant", content=[TextPart(text="Only one assistant message in history")]),
    ]
    wire_file = WireFile(tmp_path / "wire.jsonl")
    await wire_file.append_message(TurnBegin(user_input=[TextPart(text="Original question")]))
    await wire_file.append_message(StepBegin(n=1))
    await wire_file.append_message(TextPart(text="first replay step"))
    await wire_file.append_message(StepBegin(n=2))
    await wire_file.append_message(TextPart(text="second replay step"))

    step_counts: list[int] = []
    monkeypatch.setattr(replay_module.console, "print", lambda *_args, **_kwargs: None)

    async def fake_visualize(wire_ui, *, initial_status) -> None:
        steps = 0
        while True:
            try:
                msg = await wire_ui.receive()
            except QueueShutDown:
                break
            if isinstance(msg, StepBegin):
                steps += 1
        step_counts.append(steps)

    monkeypatch.setattr(replay_module, "visualize", fake_visualize)

    await replay_recent_history(history, wire_file=wire_file)

    assert step_counts == [2]


@pytest.mark.asyncio
async def test_replay_recent_history_falls_back_to_history_when_duplicate_text_steer_is_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    history = [
        Message(role="user", content=[TextPart(text="hi")]),
        Message(role="assistant", content=[TextPart(text="first answer")]),
        Message(role="user", content=[TextPart(text="hi")]),
        Message(role="assistant", content=[TextPart(text="second answer")]),
    ]
    wire_file = WireFile(tmp_path / "wire.jsonl")
    await wire_file.append_message(TurnBegin(user_input=[TextPart(text="hi")]))
    await wire_file.append_message(StepBegin(n=1))
    await wire_file.append_message(TextPart(text="first answer"))

    printed: list[str] = []
    monkeypatch.setattr(
        replay_module.console,
        "print",
        lambda text: printed.append(getattr(text, "plain", str(text))),
    )

    async def fake_visualize(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(replay_module, "visualize", fake_visualize)

    await replay_recent_history(history, wire_file=wire_file)

    assert printed == ["✨ hi", "✨ hi"]
