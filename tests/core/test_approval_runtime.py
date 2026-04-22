from __future__ import annotations

import asyncio

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
from kimi_cli.soul import run_soul
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
async def test_approval_runtime_wait_for_response_times_out() -> None:
    """wait_for_response should raise ApprovalCancelledError after timeout
    instead of hanging forever when no resolve happens.

    Regression test for: subagent approval requests that are never resolved
    cause the entire session to hang permanently.
    """
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

    # Use a very short timeout to avoid slow tests
    with pytest.raises(ApprovalCancelledError):
        await runtime.wait_for_response(request.id, timeout=0.05)

    # After timeout, the request should be cancelled and cleaned up
    record = runtime.get_request(request.id)
    assert record is not None
    assert record.status == "cancelled"
    assert record.feedback == "approval timed out"


@pytest.mark.asyncio
async def test_approval_request_timeout_carries_feedback_to_result() -> None:
    """Timeout feedback must survive round-trip through ``Approval.request``.

    Regression test: when the 300s ``wait_for_response`` safety timeout fires
    (e.g. the user stepped away from their session), ``_cancel_request`` sets
    ``record.feedback = "approval timed out"`` before raising
    ``ApprovalCancelledError``. ``Approval.request`` must read that feedback
    back into the returned ``ApprovalResult`` — otherwise the resulting
    ``ToolRejectedError`` falls back to the generic "Rejected by user" brief,
    hiding the timeout cause from the user.
    """
    from kimi_cli.soul.approval import Approval, ApprovalState
    from kimi_cli.soul.toolset import current_tool_call
    from kimi_cli.wire.types import ToolCall

    runtime = ApprovalRuntime()
    approval = Approval(state=ApprovalState(), runtime=runtime)

    token = current_tool_call.set(
        ToolCall(id="test", function=ToolCall.FunctionBody(name="Shell", arguments=None))
    )
    try:
        request_task = asyncio.create_task(
            approval.request(sender="Shell", action="shell_exec", description="ls")
        )
        while not runtime.list_pending():
            await asyncio.sleep(0)
        pending = runtime.list_pending()[0]
        # Drive the timeout path directly instead of waiting 300s: this is
        # the same internal call ``wait_for_response`` makes when its own
        # timeout expires (runtime.py uses ``feedback="approval timed out"``).
        runtime._cancel_request(pending.id, feedback="approval timed out")
        result = await request_task
    finally:
        current_tool_call.reset(token)

    assert result.approved is False
    assert result.feedback == "approval timed out"
    # The user-visible rejection surface reflects the real reason rather
    # than the generic "Rejected by user" fallback.
    err = result.rejection_error()
    assert err.brief == "Rejected: approval timed out"
