import asyncio
import contextlib
from collections.abc import Callable, Coroutine
from contextvars import ContextVar
from typing import Any

from kosong.base.message import ContentPart, ToolCallPart

from kimi_cli.soul import Soul
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import WireMessage


class Wire:
    """
    A channel for communication between the soul and the UI during a soul run.
    """

    def __init__(self):
        self._queue = asyncio.Queue[WireMessage]()
        self._soul_side = WireSoulSide(self._queue)
        self._ui_side = WireUISide(self._queue)

    @property
    def soul_side(self) -> "WireSoulSide":
        return self._soul_side

    @property
    def ui_side(self) -> "WireUISide":
        return self._ui_side

    def _shutdown(self) -> None:
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
        self._queue.put_nowait(msg)


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


_current_wire = ContextVar[Wire | None]("current_wire", default=None)


def get_wire_or_none() -> Wire | None:
    """
    Get the current wire or None.
    Expect to be not None when called from anywhere in the agent loop.
    """
    return _current_wire.get()


type UILoopFn = Callable[[WireUISide], Coroutine[Any, Any, None]]
"""A long-running async function to visualize the agent behavior."""


class RunCancelled(Exception):
    """The run was cancelled by the cancel event."""


async def run_soul(
    soul: Soul,
    user_input: str,
    ui_loop_fn: UILoopFn,
    cancel_event: asyncio.Event,
) -> None:
    """
    Run the soul with the given user input, connecting it to the UI loop with a wire.

    `cancel_event` is a outside handle that can be used to cancel the run. When the
    event is set, the run will be gracefully stopped and a `RunCancelled` will be raised.

    Raises:
        LLMNotSet: When the LLM is not set.
        ChatProviderError: When the LLM provider returns an error.
        MaxStepsReached: When the maximum number of steps is reached.
        RunCancelled: When the run is cancelled by the cancel event.
    """
    wire = Wire()
    wire_token = _current_wire.set(wire)

    logger.debug("Starting UI loop with function: {ui_loop_fn}", ui_loop_fn=ui_loop_fn)
    ui_task = asyncio.create_task(ui_loop_fn(wire.ui_side))

    logger.debug("Starting soul run")
    soul_task = asyncio.create_task(soul.run(user_input))

    cancel_event_task = asyncio.create_task(cancel_event.wait())
    await asyncio.wait(
        [soul_task, cancel_event_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    try:
        if cancel_event.is_set():
            logger.debug("Cancelling the run task")
            soul_task.cancel()
            try:
                await soul_task
            except asyncio.CancelledError:
                raise RunCancelled from None
        else:
            assert soul_task.done()  # either stop event is set or the run task is done
            cancel_event_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_event_task
            soul_task.result()  # this will raise if any exception was raised in the run task
    finally:
        logger.debug("Shutting down the UI loop")
        # shutting down the wire should break the UI loop
        wire._shutdown()
        try:
            await asyncio.wait_for(ui_task, timeout=0.5)
        except asyncio.QueueShutDown:
            # expected
            pass
        except TimeoutError:
            logger.warning("UI loop timed out")

        _current_wire.reset(wire_token)
