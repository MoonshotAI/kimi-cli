import asyncio
import contextlib
from collections.abc import Callable, Coroutine
from typing import Any

from kimi_cli.soul import Soul
from kimi_cli.soul.wire import Wire
from kimi_cli.utils.logging import logger

type UILoopFn = Callable[[Wire], Coroutine[Any, Any, None]]
"""A long-running async function to visualize the agent behavior."""


class RunCancelled(Exception):
    """The run was cancelled by the cancel event."""


async def run_soul(
    soul: Soul,
    user_input: str,
    ui_loop_fn: UILoopFn,
    cancel_event: asyncio.Event,
):
    """
    Run the soul with the given user input.

    `cancel_event` is a outside handle that can be used to cancel the run. When the event is set,
    the run will be gracefully stopped and a `RunCancelled` will be raised.

    Raises:
        LLMNotSet: When the LLM is not set.
        ChatProviderError: When the LLM provider returns an error.
        MaxStepsReached: When the maximum number of steps is reached.
        RunCancelled: When the run is cancelled by the cancel event.
    """
    wire = Wire()
    logger.debug("Starting UI loop with function: {ui_loop_fn}", ui_loop_fn=ui_loop_fn)

    ui_task = asyncio.create_task(ui_loop_fn(wire))
    soul_task = asyncio.create_task(soul.run(user_input, wire))

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
        logger.debug("Shutting down the visualization loop")
        # shutting down the event queue should break the visualization loop
        wire.shutdown()
        try:
            await asyncio.wait_for(ui_task, timeout=0.5)
        except TimeoutError:
            logger.warning("Visualization loop timed out")
