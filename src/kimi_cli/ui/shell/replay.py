from __future__ import annotations

import asyncio
import contextlib
import getpass
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import aiofiles
from kosong.message import Message, TextPart
from kosong.tooling import ToolError, ToolOk

from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.prompt import PROMPT_SYMBOL
from kimi_cli.ui.shell.visualize import visualize
from kimi_cli.utils.logging import logger
from kimi_cli.utils.message import message_stringify
from kimi_cli.wire import Wire
from kimi_cli.wire.message import (
    Event,
    StatusUpdate,
    StepBegin,
    ToolResult,
    TurnBegin,
    is_event,
)
from kimi_cli.wire.serde import WireMessageRecord

MAX_REPLAY_RUNS = 5


@dataclass(slots=True)
class _ReplayRun:
    user_message: Message
    events: list[Event]
    n_steps: int = 0


async def replay_recent_history(
    history: Sequence[Message],
    *,
    wire_file: Path | None = None,
) -> None:
    """
    Replay the most recent user-initiated runs from the provided message history or wire file.
    """
    runs = await _build_replay_runs_from_wire(wire_file)
    if not runs:
        start_idx = _find_replay_start(history)
        if start_idx is None:
            return
        runs = _build_replay_runs_from_history(history[start_idx:])
    if not runs:
        return

    for run in runs:
        wire = Wire()
        console.print(f"{getpass.getuser()}{PROMPT_SYMBOL} {message_stringify(run.user_message)}")
        ui_task = asyncio.create_task(
            visualize(wire.ui_side(merge=False), initial_status=StatusUpdate(context_usage=None))
        )
        for event in run.events:
            wire.soul_side.send(event)
            await asyncio.sleep(0)  # yield to UI loop
        wire.shutdown()
        with contextlib.suppress(asyncio.QueueShutDown):
            await ui_task


def _is_user_message(message: Message) -> bool:
    # FIXME: should consider non-text tool call results which are sent as user messages
    if message.role != "user":
        return False
    return not message.extract_text().startswith("<system>CHECKPOINT")


def _find_replay_start(history: Sequence[Message]) -> int | None:
    indices = [idx for idx, message in enumerate(history) if _is_user_message(message)]
    if not indices:
        return None
    # only replay last MAX_REPLAY_RUNS messages
    return indices[max(0, len(indices) - MAX_REPLAY_RUNS)]


async def _build_replay_runs_from_wire(wire_file: Path | None) -> list[_ReplayRun]:
    if wire_file is None or not wire_file.exists():
        return []

    runs: deque[_ReplayRun] = deque(maxlen=MAX_REPLAY_RUNS)
    try:
        async with aiofiles.open(wire_file, encoding="utf-8") as f:
            async for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = WireMessageRecord.model_validate_json(line)
                    wire_msg = record.to_wire_message()
                except Exception:
                    continue

                if isinstance(wire_msg, TurnBegin):
                    runs.append(
                        _ReplayRun(
                            user_message=Message(role="user", content=wire_msg.user_input),
                            events=[],
                        )
                    )
                    continue

                if not is_event(wire_msg) or not runs:
                    continue

                run = runs[-1]
                wire_event = cast(Event, wire_msg)
                if isinstance(wire_event, StepBegin):
                    run.n_steps = wire_event.n
                run.events.append(wire_event)
    except Exception:
        logger.exception("Failed to build replay runs from wire file {file}:", file=wire_file)
        return []
    return list(runs)


def _build_replay_runs_from_history(history: Sequence[Message]) -> list[_ReplayRun]:
    runs: list[_ReplayRun] = []
    current_run: _ReplayRun | None = None
    for message in history:
        if _is_user_message(message):
            # start a new run
            if current_run is not None:
                runs.append(current_run)
            current_run = _ReplayRun(user_message=message, events=[])
        elif message.role == "assistant":
            if current_run is None:
                continue
            current_run.n_steps += 1
            current_run.events.append(StepBegin(n=current_run.n_steps))
            current_run.events.extend(message.content)
            current_run.events.extend(message.tool_calls or [])
        elif message.role == "tool":
            if current_run is None:
                continue
            assert message.tool_call_id is not None
            if any(
                isinstance(part, TextPart) and part.text.startswith("<system>ERROR")
                for part in message.content
            ):
                result = ToolError(message="", output="", brief="")
            else:
                result = ToolOk(output=message.content)
            current_run.events.append(
                ToolResult(tool_call_id=message.tool_call_id, return_value=result)
            )
    if current_run is not None:
        runs.append(current_run)
    return runs
