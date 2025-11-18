from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from kosong.message import ContentPart, ToolCallPart

from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.wire.message import ApprovalRequest, Event


type WireMessage = Event | ApprovalRequest
"""Any message sent over the `Wire`."""


class Wire:
    """
    A channel for communication between the soul and the UI during a soul run.
    """

    def __init__(self):
        self._queue = asyncio.Queue[WireMessage]()
        self._soul_side = WireSoulSide(self._queue)
        self._ui_side = WireUISide(self._queue)

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

    def __init__(self, queue: asyncio.Queue[WireMessage]):
        self._queue = queue

    def send(self, msg: WireMessage) -> None:
        if not isinstance(msg, ContentPart | ToolCallPart):
            logger.debug("Sending wire message: {msg}", msg=msg)
        try:
            self._queue.put_nowait(msg)
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
