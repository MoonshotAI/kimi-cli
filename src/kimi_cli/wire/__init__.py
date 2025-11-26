from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import cast

import aiofiles
from kosong.message import ContentPart, MergeableMixin, ToolCallPart

from kimi_cli.utils.broadcast import BroadcastQueue
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import WireMessage, is_wire_message
from kimi_cli.wire.serde import serialize_wire_message


class Wire:
    """
    A channel for communication between the soul and the UI during a soul run.
    """

    def __init__(self, *, file_backend: Path | None = None):
        self._queue = BroadcastQueue[WireMessage]()
        self._soul_side = WireSoulSide(self._queue)
        self._ui_side = WireUISide(self._queue.subscribe())
        if file_backend is not None:
            self._recorder = WireRecorder(file_backend, self._queue.subscribe())
        else:
            self._recorder = None

    @property
    def soul_side(self) -> WireSoulSide:
        return self._soul_side

    @property
    def ui_side(self) -> WireUISide:
        return self._ui_side

    def shutdown(self) -> None:
        logger.debug("Shutting down wire")
        self._queue.shutdown()


class WireSoulSide:
    """
    The soul side of a wire.
    """

    def __init__(self, queue: BroadcastQueue[WireMessage]):
        self._queue = queue

    def send(self, msg: WireMessage) -> None:
        if not isinstance(msg, ContentPart | ToolCallPart):
            logger.debug("Sending wire message: {msg}", msg=msg)
        try:
            self._queue.publish_nowait(msg)
        except asyncio.QueueShutDown:
            logger.info("Failed to send wire message, queue is shut down: {msg}", msg=msg)


class WireUISide:
    """
    The UI side of a wire.
    """

    def __init__(self, queue: asyncio.Queue[WireMessage]):
        self._queue = queue

    async def receive(self) -> WireMessage:
        msg = await self._queue.get()
        if not isinstance(msg, ContentPart | ToolCallPart):
            logger.debug("Receiving wire message: {msg}", msg=msg)
        return msg

    def receive_nowait(self) -> WireMessage | None:
        """
        Try receive a message without waiting. If no message is available, return None.
        """
        try:
            msg = self._queue.get_nowait()
        except asyncio.QueueEmpty:
            return None
        if not isinstance(msg, ContentPart | ToolCallPart):
            logger.debug("Receiving wire message: {msg}", msg=msg)
        return msg


class WireRecorder:
    """
    Buffer and record wire messages sent through a `WireSoulSide` to a file.
    The implementation is pretty similar to `TextPrinter`.
    """

    def __init__(self, file_backend: Path, queue: asyncio.Queue[WireMessage]) -> None:
        self._file_backend = file_backend
        self._merge_buffer: MergeableMixin | None = None
        self._task = asyncio.create_task(self._consume_loop(queue))

    async def _consume_loop(self, queue: asyncio.Queue[WireMessage]) -> None:
        while True:
            try:
                msg = await queue.get()
                await self._feed(msg)
            except asyncio.QueueShutDown:
                await self._flush()
                break

    async def _feed(self, msg: WireMessage) -> None:
        match msg:
            case MergeableMixin():
                if self._merge_buffer is None:
                    self._merge_buffer = msg
                elif self._merge_buffer.merge_in_place(msg):
                    pass
                else:
                    await self._flush()
                    self._merge_buffer = msg
            case _:
                await self._flush()
                await self._record(msg)

    async def _flush(self) -> None:
        if self._merge_buffer is not None:
            assert is_wire_message(self._merge_buffer)
            await self._record(cast(WireMessage, self._merge_buffer))
            self._merge_buffer = None

    async def _record(self, msg: WireMessage) -> None:
        record = {
            "timestamp": time.time(),
            "message": serialize_wire_message(msg),
        }
        async with aiofiles.open(self._file_backend, mode="a", encoding="utf-8") as f:
            await f.write(json.dumps(record, ensure_ascii=False) + "\n")
