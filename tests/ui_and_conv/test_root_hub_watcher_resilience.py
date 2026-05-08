"""Tests for _watch_root_wire_hub resilience (Plan B).

The watcher must survive exceptions in _handle_root_hub_message and must
handle QueueShutDown gracefully, matching the pattern in wire/server.py.
"""

from __future__ import annotations

import asyncio

import pytest

from kimi_cli.utils.aioqueue import QueueShutDown


@pytest.mark.asyncio
async def test_watcher_survives_handler_exception(runtime, tmp_path) -> None:
    """If _handle_root_hub_message raises, the watcher must keep running
    and process subsequent messages instead of dying silently."""
    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.soul.agent import Agent
    from kimi_cli.soul.context import Context
    from kimi_cli.soul.kimisoul import KimiSoul
    from kimi_cli.ui.shell import Shell
    from kimi_cli.wire.types import ApprovalRequest

    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "h.jsonl"))
    shell = Shell(soul)

    hub = runtime.root_wire_hub
    handled_ids: list[str] = []
    call_count = 0

    async def flaky_handler(msg):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("Simulated crash in handler")
        # Track that subsequent messages are still processed
        if hasattr(msg, "id"):
            handled_ids.append(msg.id)

    shell._handle_root_hub_message = flaky_handler  # type: ignore[assignment]

    # Start the watcher
    watcher_task = asyncio.create_task(shell._watch_root_wire_hub())

    # Give the watcher time to subscribe and start listening
    await asyncio.sleep(0.05)

    # Send first message — handler will crash
    msg1 = ApprovalRequest(
        id="req-1",
        tool_call_id="tc-1",
        sender="WriteFile",
        action="edit",
        description="Write file test1",
    )
    hub.publish_nowait(msg1)
    await asyncio.sleep(0.05)

    # Send second message — handler should still be alive to process this
    msg2 = ApprovalRequest(
        id="req-2",
        tool_call_id="tc-2",
        sender="WriteFile",
        action="edit",
        description="Write file test2",
    )
    hub.publish_nowait(msg2)
    await asyncio.sleep(0.05)

    # Shutdown to end the watcher
    hub.shutdown()
    await asyncio.wait_for(watcher_task, timeout=1.0)

    assert call_count >= 2, "Handler should have been called at least twice"
    assert "req-2" in handled_ids, (
        "Watcher must survive the first crash and process the second message"
    )


@pytest.mark.asyncio
async def test_watcher_exits_gracefully_on_queue_shutdown(runtime, tmp_path) -> None:
    """Watcher should exit cleanly when the queue is shut down,
    not raise an unhandled QueueShutDown exception."""
    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.soul.agent import Agent
    from kimi_cli.soul.context import Context
    from kimi_cli.soul.kimisoul import KimiSoul
    from kimi_cli.ui.shell import Shell

    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "h.jsonl"))
    shell = Shell(soul)

    watcher_task = asyncio.create_task(shell._watch_root_wire_hub())
    await asyncio.sleep(0.05)

    # Shutdown the hub
    runtime.root_wire_hub.shutdown()

    # Watcher should exit without raising
    try:
        await asyncio.wait_for(watcher_task, timeout=1.0)
    except TimeoutError:
        pytest.fail("Watcher did not exit after queue shutdown")
    except QueueShutDown:
        pytest.fail("Watcher let QueueShutDown propagate instead of handling it")

    # If we reach here, the watcher exited gracefully
    assert watcher_task.done()
    # Should not have an exception result
    exc = watcher_task.exception() if not watcher_task.cancelled() else None
    assert exc is None, f"Watcher exited with unexpected exception: {exc}"
