from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Any, cast

import aiofiles
import aiofiles.os
from kosong.message import Message
from pydantic import ValidationError

from kimi_cli.soul.compaction import estimate_text_tokens
from kimi_cli.soul.message import system
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import next_available_rotation


@dataclass(slots=True)
class ProvenanceEntry:
    """Metadata about where a message came from and when it was created."""

    source: str = "user"
    timestamp: float | None = None


class Context:
    def __init__(self, file_backend: Path, *, default_source: str = "user"):
        self._file_backend = file_backend
        self._history: list[Message] = []
        self._token_count: int = 0
        self._pending_token_estimate: int = 0
        self._next_checkpoint_id: int = 0
        """The ID of the next checkpoint, starting from 0, incremented after each checkpoint."""
        self._system_prompt: str | None = None
        self._provenance: dict[int, ProvenanceEntry] = {}
        self._default_source = default_source

    async def restore(self) -> bool:
        logger.debug("Restoring context from file: {file_backend}", file_backend=self._file_backend)
        if self._history:
            logger.error("The context storage is already modified")
            raise RuntimeError("The context storage is already modified")
        if not self._file_backend.exists():
            logger.debug("No context file found, skipping restoration")
            return False
        if self._file_backend.stat().st_size == 0:
            logger.debug("Empty context file, skipping restoration")
            return False

        messages_after_last_usage: list[Message] = []
        async with aiofiles.open(self._file_backend, encoding="utf-8", errors="replace") as f:
            line_no = 0
            async for line in f:
                line_no += 1
                if not line.strip():
                    continue
                line_json = self._parse_context_line(
                    line,
                    file_backend=self._file_backend,
                    line_no=line_no,
                )
                if line_json is None:
                    continue
                self._apply_context_record(
                    line_json,
                    history=self._history,
                    messages_after_last_usage=messages_after_last_usage,
                    file_backend=self._file_backend,
                    line_no=line_no,
                )

        self._pending_token_estimate = estimate_text_tokens(messages_after_last_usage)
        return True

    @property
    def history(self) -> Sequence[Message]:
        return self._history

    @property
    def token_count(self) -> int:
        return self._token_count

    @property
    def token_count_with_pending(self) -> int:
        return self._token_count + self._pending_token_estimate

    @property
    def n_checkpoints(self) -> int:
        return self._next_checkpoint_id

    @property
    def system_prompt(self) -> str | None:
        return self._system_prompt

    @property
    def file_backend(self) -> Path:
        return self._file_backend

    def get_provenance(self, index: int) -> ProvenanceEntry | None:
        return self._provenance.get(index)

    async def write_system_prompt(self, prompt: str) -> None:
        """Write the system prompt as the first record of the context file.

        If the file is empty, writes it directly. If the file already has content
        (e.g. a legacy session without system prompt), prepends it atomically via a
        temporary file to avoid corruption on crash and avoid loading the entire file
        into memory.
        """
        prompt_line = json.dumps({"role": "_system_prompt", "content": prompt}) + "\n"

        def _write_system_prompt_sync() -> None:
            if not self._file_backend.exists() or self._file_backend.stat().st_size == 0:
                self._file_backend.write_text(prompt_line, encoding="utf-8")
                return

            tmp_path = self._file_backend.with_suffix(".tmp")
            with (
                tmp_path.open("w", encoding="utf-8") as tmp_f,
                self._file_backend.open(encoding="utf-8") as src_f,
            ):
                tmp_f.write(prompt_line)
                while True:
                    chunk = src_f.read(64 * 1024)
                    if not chunk:
                        break
                    tmp_f.write(chunk)
            tmp_path.replace(self._file_backend)

        await asyncio.to_thread(_write_system_prompt_sync)

        self._system_prompt = prompt

    async def checkpoint(self, add_user_message: bool):
        checkpoint_id = self._next_checkpoint_id
        self._next_checkpoint_id += 1
        logger.debug("Checkpointing, ID: {id}", id=checkpoint_id)

        async with aiofiles.open(self._file_backend, "a", encoding="utf-8") as f:
            await f.write(json.dumps({"role": "_checkpoint", "id": checkpoint_id}) + "\n")
        if add_user_message:
            await self.append_message(
                Message(role="user", content=[system(f"CHECKPOINT {checkpoint_id}")])
            )

    async def revert_to(self, checkpoint_id: int):
        """
        Revert the context to the specified checkpoint.
        After this, the specified checkpoint and all subsequent content will be
        removed from the context. File backend will be rotated.

        Args:
            checkpoint_id (int): The ID of the checkpoint to revert to. 0 is the first checkpoint.

        Raises:
            ValueError: When the checkpoint does not exist.
            RuntimeError: When no available rotation path is found.
        """

        logger.debug("Reverting checkpoint, ID: {id}", id=checkpoint_id)
        if checkpoint_id >= self._next_checkpoint_id:
            logger.error("Checkpoint {checkpoint_id} does not exist", checkpoint_id=checkpoint_id)
            raise ValueError(f"Checkpoint {checkpoint_id} does not exist")

        # rotate the context file
        rotated_file_path = await next_available_rotation(self._file_backend)
        if rotated_file_path is None:
            logger.error("No available rotation path found")
            raise RuntimeError("No available rotation path found")
        await aiofiles.os.replace(self._file_backend, rotated_file_path)
        logger.debug(
            "Rotated context file: {rotated_file_path}", rotated_file_path=rotated_file_path
        )

        # restore the context until the specified checkpoint
        self._history.clear()
        self._token_count = 0
        self._next_checkpoint_id = 0
        self._system_prompt = None
        self._provenance.clear()
        messages_after_last_usage: list[Message] = []
        async with (
            aiofiles.open(rotated_file_path, encoding="utf-8", errors="replace") as old_file,
            aiofiles.open(self._file_backend, "w", encoding="utf-8") as new_file,
        ):
            line_no = 0
            async for line in old_file:
                line_no += 1
                if not line.strip():
                    continue

                line_json = self._parse_context_line(
                    line,
                    file_backend=rotated_file_path,
                    line_no=line_no,
                )
                if line_json is None:
                    continue
                if line_json.get("role") == "_checkpoint" and line_json.get("id") == checkpoint_id:
                    break

                keep_line = self._apply_context_record(
                    line_json,
                    history=self._history,
                    messages_after_last_usage=messages_after_last_usage,
                    file_backend=rotated_file_path,
                    line_no=line_no,
                )
                if keep_line:
                    await new_file.write(line)

        self._pending_token_estimate = estimate_text_tokens(messages_after_last_usage)

    async def clear(self):
        """
        Clear the context history.
        This is almost equivalent to revert_to(0), but without relying on the assumption
        that the first checkpoint exists.
        File backend will be rotated.

        Raises:
            RuntimeError: When no available rotation path is found.
        """

        logger.debug("Clearing context")

        # rotate the context file
        rotated_file_path = await next_available_rotation(self._file_backend)
        if rotated_file_path is None:
            logger.error("No available rotation path found")
            raise RuntimeError("No available rotation path found")
        await aiofiles.os.replace(self._file_backend, rotated_file_path)
        self._file_backend.touch()
        logger.debug(
            "Rotated context file: {rotated_file_path}", rotated_file_path=rotated_file_path
        )

        self._history.clear()
        self._token_count = 0
        self._pending_token_estimate = 0
        self._next_checkpoint_id = 0
        self._system_prompt = None
        self._provenance.clear()

    async def append_message(
        self,
        message: Message | Sequence[Message],
        *,
        source: str | None = None,
        timestamp: float | None = None,
    ):
        logger.debug("Appending message(s) to context: {message}", message=message)
        messages = [message] if isinstance(message, Message) else message
        start_index = len(self._history)
        self._history.extend(messages)
        self._pending_token_estimate += estimate_text_tokens(messages)

        actual_source = source if source is not None else self._default_source
        ts = timestamp if timestamp is not None else time()
        async with aiofiles.open(self._file_backend, "a", encoding="utf-8") as f:
            for i, msg in enumerate(messages):
                record = json.loads(msg.model_dump_json(exclude_none=True))
                record["_source"] = actual_source
                record["_ts"] = ts
                await f.write(json.dumps(record) + "\n")
                self._provenance[start_index + i] = ProvenanceEntry(
                    source=actual_source, timestamp=ts
                )

    async def update_token_count(self, token_count: int):
        logger.debug("Updating token count in context: {token_count}", token_count=token_count)
        self._token_count = token_count
        self._pending_token_estimate = 0

        async with aiofiles.open(self._file_backend, "a", encoding="utf-8") as f:
            await f.write(json.dumps({"role": "_usage", "token_count": token_count}) + "\n")

    def _parse_context_line(
        self,
        line: str,
        *,
        file_backend: Path,
        line_no: int,
    ) -> dict[str, Any] | None:
        try:
            line_json = json.loads(line, strict=False)
        except json.JSONDecodeError as exc:
            logger.warning(
                "Skipping malformed context line {line_no} in {file}: {error}",
                line_no=line_no,
                file=file_backend,
                error=exc,
            )
            return None
        if not isinstance(line_json, dict):
            logger.warning(
                "Skipping non-object context line {line_no} in {file}",
                line_no=line_no,
                file=file_backend,
            )
            return None
        return cast(dict[str, Any], line_json)

    def _apply_context_record(
        self,
        line_json: dict[str, Any],
        *,
        history: list[Message],
        messages_after_last_usage: list[Message],
        file_backend: Path,
        line_no: int,
    ) -> bool:
        role = line_json.get("role")
        if not isinstance(role, str):
            logger.warning(
                "Skipping context line {line_no} in {file}: missing or invalid role",
                line_no=line_no,
                file=file_backend,
            )
            return False
        if role == "_system_prompt":
            content = line_json.get("content")
            if not isinstance(content, str):
                logger.warning(
                    "Skipping invalid system prompt line {line_no} in {file}",
                    line_no=line_no,
                    file=file_backend,
                )
                return False
            self._system_prompt = content
            return True
        if role == "_usage":
            token_count = line_json.get("token_count")
            if not isinstance(token_count, int):
                logger.warning(
                    "Skipping invalid usage line {line_no} in {file}",
                    line_no=line_no,
                    file=file_backend,
                )
                return False
            self._token_count = token_count
            messages_after_last_usage.clear()
            return True
        if role == "_checkpoint":
            checkpoint_id = line_json.get("id")
            if not isinstance(checkpoint_id, int):
                logger.warning(
                    "Skipping invalid checkpoint line {line_no} in {file}",
                    line_no=line_no,
                    file=file_backend,
                )
                return False
            self._next_checkpoint_id = checkpoint_id + 1
            return True
        source = line_json.pop("_source", "user")
        timestamp = line_json.pop("_ts", None)
        try:
            message = Message.model_validate(line_json)
        except ValidationError as exc:
            logger.warning(
                "Skipping invalid context message line {line_no} in {file}: {error}",
                line_no=line_no,
                file=file_backend,
                error=exc,
            )
            return False
        history.append(message)
        messages_after_last_usage.append(message)
        self._provenance[len(history) - 1] = ProvenanceEntry(source=source, timestamp=timestamp)
        return True
