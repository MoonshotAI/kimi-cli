"""Telemetry parity tests for the permission_approval_result event (TS alignment)."""

import asyncio
from unittest.mock import patch

import pytest
from kosong.message import ToolCall

from kimi_cli.soul.approval import Approval
from kimi_cli.soul.toolset import current_tool_call


def _tool_call(name: str = "Bash") -> ToolCall:
    return ToolCall(id="tc-1", function=ToolCall.FunctionBody(name=name, arguments="{}"))


def _permission_events(mock_track) -> list:
    return [c for c in mock_track.call_args_list if c[0][0] == "permission_approval_result"]


@pytest.mark.asyncio
async def test_yolo_auto_approve_emits_permission_result():
    approval = Approval(yolo=True)
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
