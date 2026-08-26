from __future__ import annotations

import asyncio
import contextlib
from typing import cast

import pytest

from kimi_cli.soul import Soul, run_soul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire


class _HangingSoul:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.task: asyncio.Task[None] | None = None

    async def run(self, _user_input: str, *, skip_user_prompt_hook: bool = False) -> None:
        self.task = asyncio.current_task()
        self.started.set()
        await asyncio.Event().wait()


async def _drain_ui(wire: Wire) -> None:
    wire_ui = wire.ui_side(merge=True)
    while True:
        try:
            await wire_ui.receive()
        except QueueShutDown:
            return


@pytest.mark.asyncio
async def test_cancelling_run_soul_cancels_nested_soul_task() -> None:
    soul = _HangingSoul()
    outer_task = asyncio.create_task(
        run_soul(cast(Soul, soul), "hello", _drain_ui, asyncio.Event())
    )

    await soul.started.wait()
    assert soul.task is not None

    try:
        outer_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await outer_task
        await asyncio.sleep(0)

        assert soul.task.done()
    finally:
        if not soul.task.done():
            soul.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await soul.task
