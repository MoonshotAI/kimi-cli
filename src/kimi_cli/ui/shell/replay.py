from __future__ import annotations

import asyncio
import contextlib
import getpass
from collections.abc import Sequence
from dataclasses import dataclass

from kosong.message import Message, TextPart
from kosong.tooling import ToolError, ToolOk

from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.prompt import PROMPT_SYMBOL
from kimi_cli.ui.shell.visualize import visualize
from kimi_cli.utils.message import message_stringify
from kimi_cli.wire import Wire
from kimi_cli.wire.message import ContentPart, StatusUpdate, StepBegin, ToolCall, ToolResult

MAX_REPLAY_RUNS = 5

type _ReplayEvent = StepBegin | ToolCall | ContentPart | ToolResult


@dataclass(slots=True)
class _ReplayRun:
    user_message: Message
    events: list[_ReplayEvent]
    n_steps: int = 0


async def replay_recent_history(history: Sequence[Message]) -> None:
    """
    Replay the most recent user-initiated runs from the provided message history.
    """
    start_idx = _find_replay_start(history)
    if start_idx is None:
        return

    runs = _build_replay_runs(history[start_idx:])
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


def _build_replay_runs(history: Sequence[Message]) -> list[_ReplayRun]:
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
