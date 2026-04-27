from __future__ import annotations

import asyncio
import contextlib

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.approval_runtime import (
    ApprovalCancelledError,
    ApprovalRuntime,
    ApprovalSource,
    get_current_approval_source_or_none,
    reset_current_approval_source,
    set_current_approval_source,
)
from kimi_cli.soul import RunCancelled, run_soul
from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.root_hub import RootWireHub
from kimi_cli.wire.types import ApprovalRequest, ApprovalResponse


@pytest.mark.asyncio
async def test_approval_runtime_create_wait_and_resolve() -> None:
    runtime = ApprovalRuntime()
    request = runtime.create_request(
        request_id="req-1",
        tool_call_id="call-1",
        sender="Shell",
        action="run command",
        description="ls",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-1"),
    )

    waiter = asyncio.create_task(runtime.wait_for_response(request.id))
    assert runtime.list_pending() == [request]

    assert runtime.resolve(request.id, "approve") is True
    response, feedback = await waiter
    assert response == "approve"
    assert feedback == ""
    assert runtime.list_pending() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    [
        ApprovalSource(kind="foreground_turn", id="turn-no-timeout"),
        ApprovalSource(
            kind="background_agent",
            id="task-no-timeout",
            agent_id="a1234567",
            subagent_type="coder",
        ),
    ],
)
async def test_approval_runtime_wait_for_response_waits_indefinitely_by_default(
    monkeypatch: pytest.MonkeyPatch,
    source: ApprovalSource,
) -> None:
    """Approval requests must wait until the user responds unless explicitly cancelled."""
    runtime = ApprovalRuntime()
    request = runtime.create_request(
        request_id=f"req-no-timeout-{source.kind}",
        tool_call_id=f"call-no-timeout-{source.kind}",
        sender="WriteFile",
        action="edit file",
        description="Write file /tmp/test.txt",
        display=[],
        source=source,
    )

    async def fail_on_finite_timeout(awaitable, timeout=None):
        if timeout is not None:
            raise TimeoutError
        return await awaitable

    monkeypatch.setattr(asyncio, "wait_for", fail_on_finite_timeout)

    waiter = asyncio.create_task(runtime.wait_for_response(request.id))
    try:
        await asyncio.sleep(0)
        if waiter.done():
            with pytest.raises(ApprovalCancelledError):
                await waiter
            pytest.fail("wait_for_response used a finite default timeout")

        record = runtime.get_request(request.id)
        assert record is not None
        assert record.status == "pending"

        assert runtime.resolve(request.id, "approve") is True
        response, feedback = await waiter
        assert response == "approve"
        assert feedback == ""
    finally:
        if not waiter.done():
            waiter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await waiter


@pytest.mark.asyncio
async def test_approval_runtime_wait_for_response_explicit_timeout() -> None:
    runtime = ApprovalRuntime()
    request = runtime.create_request(
        request_id="req-timeout",
        tool_call_id="call-timeout",
        sender="WriteFile",
        action="edit file",
        description="Write file /tmp/test.txt",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-timeout"),
    )

    with pytest.raises(ApprovalCancelledError):
        await runtime.wait_for_response(request.id, timeout=0.05)

    record = runtime.get_request(request.id)
    assert record is not None
    assert record.status == "cancelled"
    assert record.feedback == "approval timed out"


@pytest.mark.asyncio
async def test_approval_runtime_cancelled_waiter_does_not_orphan_shared_waiter() -> None:
    runtime = ApprovalRuntime()
    request = runtime.create_request(
        request_id="req-shared-cancel",
        tool_call_id="call-shared-cancel",
        sender="WriteFile",
        action="edit file",
        description="Write file /tmp/test.txt",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-shared-cancel"),
    )

    waiter_one = asyncio.create_task(runtime.wait_for_response(request.id))
    waiter_two = asyncio.create_task(runtime.wait_for_response(request.id))

    await asyncio.sleep(0)
    waiter_one.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter_one

    assert runtime.resolve(request.id, "approve") is True
    response, feedback = await waiter_two
    assert response == "approve"
    assert feedback == ""


@pytest.mark.asyncio
async def test_approval_runtime_timeout_cancels_all_shared_waiters() -> None:
    runtime = ApprovalRuntime()
    request = runtime.create_request(
        request_id="req-shared-timeout",
        tool_call_id="call-shared-timeout",
        sender="WriteFile",
        action="edit file",
        description="Write file /tmp/test.txt",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-shared-timeout"),
    )

    waiter_one = asyncio.create_task(runtime.wait_for_response(request.id, timeout=0.05))
    waiter_two = asyncio.create_task(runtime.wait_for_response(request.id))

    with pytest.raises(ApprovalCancelledError):
        await waiter_one
    with pytest.raises(ApprovalCancelledError):
        await waiter_two

    record = runtime.get_request(request.id)
    assert record is not None
    assert record.status == "cancelled"
    assert record.feedback == "approval timed out"


@pytest.mark.asyncio
async def test_approval_runtime_cancel_by_source() -> None:
    runtime = ApprovalRuntime()
    request = runtime.create_request(
        request_id="req-2",
        tool_call_id="call-2",
        sender="WriteFile",
        action="edit file",
        description="write",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-1"),
    )

    waiter = asyncio.create_task(runtime.wait_for_response(request.id))
    assert runtime.cancel_by_source("background_agent", "task-1") == 1
    with pytest.raises(ApprovalCancelledError):
        await waiter


def test_approval_runtime_cancel_by_source_publishes_terminal_response() -> None:
    runtime = ApprovalRuntime()
    hub = RootWireHub()
    queue = hub.subscribe()
    runtime.bind_root_wire_hub(hub)

    request = runtime.create_request(
        request_id="req-2b",
        tool_call_id="call-2b",
        sender="WriteFile",
        action="edit file",
        description="write",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-2b"),
    )
    msg = queue.get_nowait()
    assert isinstance(msg, ApprovalRequest)
    assert msg.id == request.id

    assert runtime.cancel_by_source("background_agent", "task-2b") == 1
    msg = queue.get_nowait()
    assert isinstance(msg, ApprovalResponse)
    assert msg.request_id == request.id
    assert msg.response == "reject"


def test_approval_runtime_cancel_by_source_publishes_runtime_event() -> None:
    runtime = ApprovalRuntime()
    seen: list[tuple[str, str, str | None]] = []

    def _subscriber(event) -> None:
        seen.append((event.kind, event.request.id, event.request.response))

    token = runtime.subscribe(_subscriber)
    try:
        request = runtime.create_request(
            request_id="req-2c",
            tool_call_id="call-2c",
            sender="WriteFile",
            action="edit file",
            description="write",
            display=[],
            source=ApprovalSource(kind="background_agent", id="task-2c"),
        )
        assert runtime.cancel_by_source("background_agent", "task-2c") == 1
    finally:
        runtime.unsubscribe(token)

    assert seen == [
        ("request_created", request.id, None),
        ("request_resolved", request.id, "reject"),
    ]


def test_approval_runtime_publishes_to_root_wire_hub() -> None:
    runtime = ApprovalRuntime()
    hub = RootWireHub()
    queue = hub.subscribe()
    runtime.bind_root_wire_hub(hub)

    request = runtime.create_request(
        request_id="req-3",
        tool_call_id="call-3",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(
            kind="background_agent",
            id="task-3",
            agent_id="a1234567",
            subagent_type="coder",
        ),
    )
    msg = queue.get_nowait()
    assert isinstance(msg, ApprovalRequest)
    assert msg.id == request.id
    assert msg.source_kind == "background_agent"
    assert msg.agent_id == "a1234567"
    assert msg.subagent_type == "coder"

    assert runtime.resolve(request.id, "reject") is True
    msg = queue.get_nowait()
    assert isinstance(msg, ApprovalResponse)
    assert msg.request_id == request.id
    assert msg.response == "reject"


async def _drain_ui_messages(wire: Wire) -> None:
    wire_ui = wire.ui_side(merge=True)
    while True:
        try:
            await wire_ui.receive()
        except QueueShutDown:
            return


@pytest.mark.asyncio
async def test_kimisoul_run_preserves_existing_approval_source(
    runtime, tmp_path, monkeypatch
) -> None:
    seen_sources: list[ApprovalSource | None] = []

    async def fake_turn(self, user_message):
        seen_sources.append(get_current_approval_source_or_none())
        return None

    async def fake_ensure_fresh(_runtime):
        return None

    monkeypatch.setattr(KimiSoul, "_turn", fake_turn)
    monkeypatch.setattr(runtime.oauth, "ensure_fresh", fake_ensure_fresh)

    soul = KimiSoul(
        SoulAgent(
            name="test",
            system_prompt="test prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=Context(file_backend=tmp_path / "history.jsonl"),
    )

    source = ApprovalSource(
        kind="background_agent",
        id="task-approval",
        agent_id="a1234567",
        subagent_type="coder",
    )
    token = set_current_approval_source(source)
    try:
        await run_soul(soul, "ping", _drain_ui_messages, asyncio.Event(), runtime=runtime)
        assert get_current_approval_source_or_none() == source
    finally:
        reset_current_approval_source(token)

    assert seen_sources == [source]


@pytest.mark.asyncio
async def test_kimisoul_run_cancels_own_foreground_approvals_on_cancel(
    runtime, tmp_path, monkeypatch
) -> None:
    assert runtime.approval_runtime is not None
    request_created = asyncio.Event()

    async def fake_turn(self, user_message):
        source = get_current_approval_source_or_none()
        assert source is not None
        assert source.kind == "foreground_turn"
        foreground_request = runtime.approval_runtime.create_request(
            request_id="req-foreground-cancelled",
            tool_call_id="call-foreground-cancelled",
            sender="WriteFile",
            action="edit file",
            description="write foreground file",
            display=[],
            source=source,
        )
        runtime.approval_runtime.create_request(
            request_id="req-background-still-pending",
            tool_call_id="call-background-still-pending",
            sender="WriteFile",
            action="edit file",
            description="write background file",
            display=[],
            source=ApprovalSource(kind="background_agent", id="task-still-running"),
        )
        request_created.set()
        await runtime.approval_runtime.wait_for_response(foreground_request.id)

    async def fake_ensure_fresh(_runtime):
        return None

    monkeypatch.setattr(KimiSoul, "_turn", fake_turn)
    monkeypatch.setattr(runtime.oauth, "ensure_fresh", fake_ensure_fresh)

    soul = KimiSoul(
        SoulAgent(
            name="test",
            system_prompt="test prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=Context(file_backend=tmp_path / "history.jsonl"),
    )

    cancel_event = asyncio.Event()
    run_task = asyncio.create_task(
        run_soul(soul, "ping", _drain_ui_messages, cancel_event, runtime=runtime)
    )

    await asyncio.wait_for(request_created.wait(), timeout=1.0)
    cancel_event.set()
    with pytest.raises(RunCancelled):
        await asyncio.wait_for(run_task, timeout=1.0)

    foreground = runtime.approval_runtime.get_request("req-foreground-cancelled")
    assert foreground is not None
    assert foreground.status == "cancelled"
    assert foreground.response == "reject"

    background = runtime.approval_runtime.get_request("req-background-still-pending")
    assert background is not None
    assert background.status == "pending"
    assert runtime.approval_runtime.list_pending() == [background]
