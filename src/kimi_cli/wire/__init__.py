from __future__ import annotations

import asyncio
import copy
import json
import time
from pathlib import Path
from typing import cast

import aiofiles
from kosong.message import ContentPart, MergeableMixin, ToolCallPart

from kimi_cli.utils.broadcast import BroadcastQueue
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import WireMessage, is_wire_message
from kimi_cli.wire.serde import WireMessageRecord

WireMessageQueue = BroadcastQueue[WireMessage]


class Wire:
    """
    A spmc channel for communication between the soul and the UI during a soul run.
    """

    def __init__(self, *, file_backend: Path | None = None):
        self._raw_queue = WireMessageQueue()
        self._merged_queue = WireMessageQueue()

        self._soul_side = WireSoulSide(self._raw_queue, self._merged_queue)

        if file_backend is not None:
            # record all complete Wire messages to the file backend
            self._recorder = _WireRecorder(file_backend, self._merged_queue.subscribe())
        else:
            self._recorder = None

    @property
    def soul_side(self) -> WireSoulSide:
        return self._soul_side

    def ui_side(self, *, merge: bool) -> WireUISide:
        """
        Create a UI side of the `Wire`.

        Args:
            merge: Whether to merge `Wire` messages as much as possible.
        """
        if merge:
            return WireUISide(self._merged_queue.subscribe())
        else:
            return WireUISide(self._raw_queue.subscribe())

    def shutdown(self) -> None:
        self.soul_side.flush()
        logger.debug("Shutting down wire")
        self._raw_queue.shutdown()
        self._merged_queue.shutdown()


class WireSoulSide:
    """
    The soul side of a `Wire`.
    """

    def __init__(self, raw_queue: WireMessageQueue, merged_queue: WireMessageQueue):
        self._raw_queue = raw_queue
        self._merged_queue = merged_queue
        self._merge_buffer: MergeableMixin | None = None

    def send(self, msg: WireMessage) -> None:
        if not isinstance(msg, ContentPart | ToolCallPart):
            logger.debug("Sending wire message: {msg}", msg=msg)

        # send raw message
        try:
            self._raw_queue.publish_nowait(msg)
        except asyncio.QueueShutDown:
            logger.info("Failed to send raw wire message, queue is shut down: {msg}", msg=msg)

        # merge and send merged message
        match msg:
            case MergeableMixin():
                if self._merge_buffer is None:
                    self._merge_buffer = copy.deepcopy(msg)
                elif self._merge_buffer.merge_in_place(msg):
                    pass
                else:
                    self.flush()
                    self._merge_buffer = copy.deepcopy(msg)
            case _:
                self.flush()
                self._send_merged(msg)

    def flush(self) -> None:
        if self._merge_buffer is not None:
            assert is_wire_message(self._merge_buffer)
            self._send_merged(cast(WireMessage, self._merge_buffer))
            self._merge_buffer = None

    def _send_merged(self, msg: WireMessage) -> None:
        try:
            self._merged_queue.publish_nowait(msg)
        except asyncio.QueueShutDown:
            logger.info("Failed to send merged wire message, queue is shut down: {msg}", msg=msg)


class WireUISide:
    """
    The UI side of a `Wire`.
    """

    def __init__(self, queue: asyncio.Queue[WireMessage]):
        self._queue = queue

    async def receive(self) -> WireMessage:
        msg = await self._queue.get()
        if not isinstance(msg, ContentPart | ToolCallPart):
            logger.debug("Receiving wire message: {msg}", msg=msg)
        return msg


class _WireRecorder:
    def __init__(self, file_backend: Path, queue: asyncio.Queue[WireMessage]) -> None:
        self._file_backend = file_backend
        self._task = asyncio.create_task(self._consume_loop(queue))

    async def _consume_loop(self, queue: asyncio.Queue[WireMessage]) -> None:
        while True:
            try:
                msg = await queue.get()
                await self._record(msg)
            except asyncio.QueueShutDown:
                break

    async def _record(self, msg: WireMessage) -> None:
        record = WireMessageRecord.from_wire_message(msg, timestamp=time.time())
        async with aiofiles.open(self._file_backend, mode="a", encoding="utf-8") as f:
            await f.write(json.dumps(record.model_dump(mode="json"), ensure_ascii=False) + "\n")
