"""Telemetry parity tests for the permission_approval_result event (TS alignment)."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from kosong.message import ToolCall

from kimi_cli.soul.approval import Approval
from kimi_cli.soul.toolset import KimiToolset, current_tool_call


def _tool_call(name: str = "Bash", *, call_id: str = "tc-1") -> ToolCall:
    return ToolCall(id=call_id, function=ToolCall.FunctionBody(name=name, arguments="{}"))


def _permission_events(mock_track) -> list:
    return [c for c in mock_track.call_args_list if c[0][0] == "permission_approval_result"]


@pytest.mark.asyncio
async def test_manual_approval_triggers_permission_prompt_notification_hook() -> None:
    approval = Approval()
    hook_engine = MagicMock()
    approval.set_hook_engine(hook_engine, session_id="session-1", cwd="/work")
    token = current_tool_call.set(_tool_call())
    try:
        request_task = asyncio.create_task(approval.request("Bash", "bash:ls", "Run command: ls"))
        await asyncio.sleep(0)
        pending = approval.runtime.list_pending()
        assert len(pending) == 1

        hook_engine.fire_and_forget_trigger.assert_called_once_with(
            "Notification",
            matcher_value="permission_prompt",
            input_data={
                "hook_event_name": "Notification",
                "session_id": "session-1",
                "cwd": "/work",
                "sink": "shell",
                "notification_type": "permission_prompt",
                "title": "Bash requires approval",
                "body": "Run command: ls",
                "severity": "info",
            },
        )
        approval.runtime.resolve(pending[0].id, "approve")
        assert await request_task
    finally:
        current_tool_call.reset(token)


@pytest.mark.asyncio
async def test_auto_approval_does_not_trigger_permission_prompt_hook() -> None:
    approval = Approval(yolo=True)
    hook_engine = MagicMock()
    approval.set_hook_engine(hook_engine, session_id="session-1", cwd="/work")
    token = current_tool_call.set(_tool_call())
    try:
        assert await approval.request("Bash", "bash:ls", "Run command: ls")
    finally:
        current_tool_call.reset(token)

    hook_engine.fire_and_forget_trigger.assert_not_called()


@pytest.mark.asyncio
async def test_yolo_auto_approve_emits_permission_result():
    approval = Approval(yolo=True)
    KimiToolset().begin_step([], step_no=3)
    token = current_tool_call.set(_tool_call())
    try:
        with patch("kimi_cli.telemetry.track") as mock_track:
            result = await approval.request("Bash", "bash:ls", "list files")
    finally:
        current_tool_call.reset(token)

    assert result.approved is True
    calls = _permission_events(mock_track)
    assert len(calls) == 1
    kwargs = calls[0][1]
    assert kwargs["result"] == "approved"
    assert kwargs["permission_mode"] == "yolo"
    assert kwargs["tool_name"] == "Bash"
    assert kwargs["step_no"] == 3
    assert kwargs["approval_surface"] == "generic"
    assert kwargs["session_cache_written"] is False
    assert kwargs["has_feedback"] is False
    assert kwargs["policy_name"] is None
    assert kwargs["duration_ms"] >= 0


@pytest.mark.asyncio
async def test_afk_auto_approve_maps_to_auto_mode():
    from kimi_cli.soul.approval import ApprovalState

    approval = Approval(state=ApprovalState(afk=True))
    token = current_tool_call.set(_tool_call())
    try:
        with patch("kimi_cli.telemetry.track") as mock_track:
            result = await approval.request("Bash", "bash:ls", "list files")
    finally:
        current_tool_call.reset(token)

    assert result.approved is True
    calls = _permission_events(mock_track)
    assert len(calls) == 1
    assert calls[0][1]["permission_mode"] == "auto"
    assert calls[0][1]["result"] == "approved"


@pytest.mark.asyncio
async def test_manual_approve_emits_permission_result():
    approval = Approval()
    token = current_tool_call.set(_tool_call())
    try:
        with patch("kimi_cli.telemetry.track") as mock_track:

            async def resolve_later():
                await asyncio.sleep(0.02)
                for pending in approval._runtime.list_pending():
                    approval._runtime.resolve(pending.id, "approve")

            resolver = asyncio.create_task(resolve_later())
            result = await approval.request("Bash", "bash:ls", "list files")
            await resolver
    finally:
        current_tool_call.reset(token)

    assert result.approved is True
    calls = _permission_events(mock_track)
    assert len(calls) == 1
    kwargs = calls[0][1]
    assert kwargs["result"] == "approved"
    assert kwargs["permission_mode"] == "manual"
    assert kwargs["session_cache_written"] is False


@pytest.mark.asyncio
async def test_manual_approve_for_session_writes_cache():
    approval = Approval()
    token = current_tool_call.set(_tool_call())
    try:
        with patch("kimi_cli.telemetry.track") as mock_track:

            async def resolve_later():
                await asyncio.sleep(0.02)
                for pending in approval._runtime.list_pending():
                    approval._runtime.resolve(pending.id, "approve_for_session")

            resolver = asyncio.create_task(resolve_later())
            result = await approval.request("Bash", "bash:ls", "list files")
            await resolver
    finally:
        current_tool_call.reset(token)

    assert result.approved is True
    assert "bash:ls" in approval._state.auto_approve_actions
    calls = _permission_events(mock_track)
    assert len(calls) == 1
    kwargs = calls[0][1]
    assert kwargs["result"] == "approved_for_session"
    assert kwargs["session_cache_written"] is True


@pytest.mark.asyncio
async def test_manual_reject_with_feedback():
    approval = Approval()
    token = current_tool_call.set(_tool_call())
    try:
        with patch("kimi_cli.telemetry.track") as mock_track:

            async def resolve_later():
                await asyncio.sleep(0.02)
                for pending in approval._runtime.list_pending():
                    approval._runtime.resolve(pending.id, "reject", feedback="do not")

            resolver = asyncio.create_task(resolve_later())
            result = await approval.request("Bash", "bash:rm", "remove files")
            await resolver
    finally:
        current_tool_call.reset(token)

    assert result.approved is False
    assert result.feedback == "do not"
    calls = _permission_events(mock_track)
    assert len(calls) == 1
    kwargs = calls[0][1]
    assert kwargs["result"] == "rejected"
    assert kwargs["has_feedback"] is True


@pytest.mark.asyncio
async def test_session_cached_action_emits_auto_mode():
    from kimi_cli.soul.approval import ApprovalState

    approval = Approval(state=ApprovalState(auto_approve_actions={"bash:ls"}))
    token = current_tool_call.set(_tool_call())
    try:
        with patch("kimi_cli.telemetry.track") as mock_track:
            result = await approval.request("Bash", "bash:ls", "list files")
    finally:
        current_tool_call.reset(token)

    assert result.approved is True
    calls = _permission_events(mock_track)
    assert len(calls) == 1
    kwargs = calls[0][1]
    assert kwargs["result"] == "approved"
    assert kwargs["permission_mode"] == "auto"
    assert kwargs["session_cache_written"] is False


@pytest.mark.asyncio
async def test_session_approval_marks_other_pending_requests_as_cache_approved():
    approval = Approval()

    async def request(call_id: str):
        token = current_tool_call.set(_tool_call(call_id=call_id))
        try:
            return await approval.request("Bash", "bash:ls", "list files")
        finally:
            current_tool_call.reset(token)

    with patch("kimi_cli.telemetry.track") as mock_track:
        first = asyncio.create_task(request("tc-1"))
        second = asyncio.create_task(request("tc-2"))
        await asyncio.sleep(0)
        pending = approval._runtime.list_pending()
        assert len(pending) == 2
        approval._runtime.resolve(pending[0].id, "approve_for_session")
        await asyncio.gather(first, second)

    calls = _permission_events(mock_track)
    assert len(calls) == 2
    event_props = [call[1] for call in calls]
    assert any(
        props["result"] == "approved_for_session"
        and props["permission_mode"] == "manual"
        and props["session_cache_written"] is True
        for props in event_props
    )
    assert any(
        props["result"] == "approved"
        and props["permission_mode"] == "auto"
        and props["session_cache_written"] is False
        for props in event_props
    )
