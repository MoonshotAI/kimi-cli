from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import aiofiles
import aiofiles.os
from kosong.message import Message


@dataclass
class HistoryFilterResult:
    history: list[Message]
    token_count: int
    next_checkpoint_id: int
    removed: bool


async def filter_messages(
    *,
    file_backend: Path,
    history: Sequence[Message],
    keep: Callable[[Message], bool],
    token_count: int,
    next_checkpoint_id: int,
) -> HistoryFilterResult:
    """
    Rewrite history by keeping messages that satisfy *keep* while preserving usage
    and checkpoint records. Returns the new state and whether any message was removed.
    """
    if not file_backend.exists():
        filtered_history = [message for message in history if keep(message)]
        removed = len(filtered_history) != len(history)
        return HistoryFilterResult(
            history=filtered_history,
            token_count=token_count,
            next_checkpoint_id=next_checkpoint_id,
            removed=removed,
        )

    new_token_count = 0
    new_next_checkpoint_id = 0
    temp_file = file_backend.with_suffix(file_backend.suffix + ".tmp")
    removed = False
    new_history: list[Message] = []

    async with (
        aiofiles.open(file_backend, encoding="utf-8") as src,
        aiofiles.open(temp_file, "w", encoding="utf-8") as dst,
    ):
        async for line in src:
            if not line.strip():
                continue

            line_json = json.loads(line)
            role = line_json.get("role")
            if role == "_usage":
                new_token_count = line_json["token_count"]
                await dst.write(line)
                continue
            if role == "_checkpoint":
                new_next_checkpoint_id = line_json["id"] + 1
                await dst.write(line)
                continue

            message = Message.model_validate(line_json)
            if keep(message):
                new_history.append(message)
                await dst.write(message.model_dump_json(exclude_none=True) + "\n")
            else:
                removed = True

    if removed:
        await aiofiles.os.replace(temp_file, file_backend)
    else:
        await aiofiles.os.remove(temp_file)

    return HistoryFilterResult(
        history=new_history,
        token_count=new_token_count,
        next_checkpoint_id=new_next_checkpoint_id,
        removed=removed,
    )
