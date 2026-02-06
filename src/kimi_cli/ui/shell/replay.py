from __future__ import annotations

import asyncio
import contextlib
import getpass
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass

from kosong.message import ContentPart, Message
from kosong.tooling import ToolError, ToolOk

from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.prompt import PROMPT_SYMBOL
from kimi_cli.ui.shell.visualize import visualize
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.utils.logging import logger
from kimi_cli.utils.message import message_stringify
from kimi_cli.utils.slashcmd import parse_slash_command_call
from kimi_cli.wire import Wire
from kimi_cli.wire.file import WireFile
from kimi_cli.wire.types import (
    Event,
    StatusUpdate,
    StepBegin,
    TextPart,
    ToolResult,
    TurnBegin,
    is_event,
)

MAX_REPLAY_TURNS = 5


@dataclass(slots=True)
class _ReplayTurn:
    user_message: Message
    events: list[Event]
    n_steps: int = 0


async def replay_recent_history(
    history: Sequence[Message],
    *,
    wire_file: WireFile | None = None,
) -> None:
    """
    Replay the most recent user-initiated turns from the provided message history or wire file.
    """
    if not history:
        # if the context history is empty,either this is a new session
        # or the context has been cleared
        return

    turns = await _build_replay_turns_from_wire(wire_file)
    if not turns:
        start_idx = _find_replay_start(history)
        if start_idx is None:
            return
        turns = _build_replay_turns_from_history(history[start_idx:])
    if not turns:
        return

    for turn in turns:
        wire = Wire()
        console.print(f"{getpass.getuser()}{PROMPT_SYMBOL} {message_stringify(turn.user_message)}")
        ui_task = asyncio.create_task(
            visualize(wire.ui_side(merge=False), initial_status=StatusUpdate())
        )
        for event in turn.events:
            wire.soul_side.send(event)
            await asyncio.sleep(0)  # yield to UI loop
        wire.shutdown()
        with contextlib.suppress(QueueShutDown):
            await ui_task


async def _build_replay_turns_from_wire(wire_file: WireFile | None) -> list[_ReplayTurn]:
    if wire_file is None or not wire_file.path.exists():
        return []

    size = wire_file.path.stat().st_size
    if size > 20 * 1024 * 1024:
        logger.info(
            "Wire file too large for replay, skipping: {file} ({size} bytes)",
            file=wire_file.path,
            size=size,
        )
        return []

    turns: deque[_ReplayTurn] = deque(maxlen=MAX_REPLAY_TURNS)
    try:
        async for record in wire_file.iter_records():
            wire_msg = record.to_wire_message()

            if isinstance(wire_msg, TurnBegin):
                if _is_clear_command_input(wire_msg.user_input):
                    turns.clear()
                    continue
                turns.append(
                    _ReplayTurn(
                        user_message=Message(role="user", content=wire_msg.user_input),
                        events=[],
                    )
                )
                continue

            if not is_event(wire_msg) or not turns:
                continue

            current_turn = turns[-1]
            if isinstance(wire_msg, StepBegin):
                current_turn.n_steps = wire_msg.n
            current_turn.events.append(wire_msg)
    except Exception:
        logger.exception("Failed to build replay turns from wire file {file}:", file=wire_file.path)
        return []
    return list(turns)


def _is_clear_command_input(user_input: str | list[ContentPart]) -> bool:
    if isinstance(user_input, list):
        text = Message(role="user", content=user_input).extract_text(" ").strip()
    else:
        text = str(user_input).strip()
    call = parse_slash_command_call(text)
    if call is None:
        return False
    return call.name in {"clear", "reset"}


def _is_user_message(message: Message) -> bool:
    # FIXME: should consider non-text tool call results which are sent as user messages
    if message.role != "user":
        return False
    return not message.extract_text().startswith("<system>CHECKPOINT")


def _find_replay_start(history: Sequence[Message]) -> int | None:
    indices = [idx for idx, message in enumerate(history) if _is_user_message(message)]
    if not indices:
        return None
    # only replay last MAX_REPLAY_TURNS messages
    return indices[max(0, len(indices) - MAX_REPLAY_TURNS)]


def _build_replay_turns_from_history(history: Sequence[Message]) -> list[_ReplayTurn]:
    turns: list[_ReplayTurn] = []
    current_turn: _ReplayTurn | None = None
    for message in history:
        if _is_user_message(message):
            # start a new turn
            if current_turn is not None:
                turns.append(current_turn)
            current_turn = _ReplayTurn(user_message=message, events=[])
        elif message.role == "assistant":
            if current_turn is None:
                continue
            current_turn.n_steps += 1
            current_turn.events.append(StepBegin(n=current_turn.n_steps))
            current_turn.events.extend(message.content)
            current_turn.events.extend(message.tool_calls or [])
        elif message.role == "tool":
            if current_turn is None:
                continue
            assert message.tool_call_id is not None
            if any(
                isinstance(part, TextPart) and part.text.startswith("<system>ERROR")
                for part in message.content
            ):
                result = ToolError(message="", output="", brief="")
            else:
                result = ToolOk(output=message.content)
            current_turn.events.append(
                ToolResult(tool_call_id=message.tool_call_id, return_value=result)
            )
    if current_turn is not None:
        turns.append(current_turn)
    return turns
