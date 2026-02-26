"""Tests for session state persistence."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.session_state import (
    ApprovalStateData,
    DynamicSubagentSpec,
    SessionState,
    load_session_state,
    save_session_state,
)


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    return tmp_path / "session"


class TestSessionState:
    def test_default_state(self):
        state = SessionState()
        assert state.version == 1
        assert state.approval.yolo is False
        assert state.approval.auto_approve_actions == set()
        assert state.dynamic_subagents == []

    def test_save_and_load_roundtrip(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state = SessionState(
            approval=ApprovalStateData(
                yolo=True,
                auto_approve_actions={"Shell", "WriteFile"},
            ),
            dynamic_subagents=[
                DynamicSubagentSpec(name="researcher", system_prompt="You are a researcher."),
            ],
        )
        save_session_state(state, state_dir)

        loaded = load_session_state(state_dir)
        assert loaded.version == 1
        assert loaded.approval.yolo is True
        assert loaded.approval.auto_approve_actions == {"Shell", "WriteFile"}
        assert len(loaded.dynamic_subagents) == 1
        assert loaded.dynamic_subagents[0].name == "researcher"
        assert loaded.dynamic_subagents[0].system_prompt == "You are a researcher."

    def test_load_missing_file_returns_default(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state = load_session_state(state_dir)
        assert state == SessionState()

    def test_load_missing_dir_returns_default(self, tmp_path: Path):
        state = load_session_state(tmp_path / "nonexistent")
        assert state == SessionState()

    def test_save_creates_valid_json(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state = SessionState(
            approval=ApprovalStateData(yolo=True, auto_approve_actions={"Shell"}),
        )
        save_session_state(state, state_dir)

        state_file = state_dir / "state.json"
        assert state_file.exists()
        data = json.loads(state_file.read_text(encoding="utf-8"))
        assert data["version"] == 1
        assert data["approval"]["yolo"] is True
        assert set(data["approval"]["auto_approve_actions"]) == {"Shell"}

    def test_overwrite_existing_state(self, state_dir: Path):
        state_dir.mkdir(parents=True)

        state1 = SessionState(
            approval=ApprovalStateData(yolo=False, auto_approve_actions={"Shell"}),
        )
        save_session_state(state1, state_dir)

        state2 = SessionState(
            approval=ApprovalStateData(yolo=True, auto_approve_actions={"Shell", "WriteFile"}),
        )
        save_session_state(state2, state_dir)

        loaded = load_session_state(state_dir)
        assert loaded.approval.yolo is True
        assert loaded.approval.auto_approve_actions == {"Shell", "WriteFile"}

    def test_multiple_dynamic_subagents(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state = SessionState(
            dynamic_subagents=[
                DynamicSubagentSpec(name="researcher", system_prompt="Research things."),
                DynamicSubagentSpec(name="coder", system_prompt="Write code."),
            ],
        )
        save_session_state(state, state_dir)

        loaded = load_session_state(state_dir)
        assert len(loaded.dynamic_subagents) == 2
        assert loaded.dynamic_subagents[0].name == "researcher"
        assert loaded.dynamic_subagents[1].name == "coder"

    def test_load_truncated_json_returns_default(self, state_dir: Path):
        """Simulates a crash mid-write leaving a truncated JSON file."""
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        state_file.write_text('{"version": 1, "approval":', encoding="utf-8")

        state = load_session_state(state_dir)
        assert state == SessionState()

    def test_load_invalid_json_returns_default(self, state_dir: Path):
        """Completely invalid JSON content."""
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        state_file.write_text("not json at all", encoding="utf-8")

        state = load_session_state(state_dir)
        assert state == SessionState()

    def test_load_invalid_schema_returns_default(self, state_dir: Path):
        """Valid JSON but invalid schema (e.g. wrong type for a field)."""
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        state_file.write_text(
            json.dumps({"version": "not_an_int", "approval": "bad"}),
            encoding="utf-8",
        )

        state = load_session_state(state_dir)
        assert state == SessionState()

    def test_load_empty_file_returns_default(self, state_dir: Path):
        """An empty state.json (e.g. process killed right after file creation)."""
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        state_file.write_bytes(b"")

        state = load_session_state(state_dir)
        assert state == SessionState()

    def test_load_binary_garbage_returns_default(self, state_dir: Path):
        """Binary corruption that isn't valid UTF-8."""
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        state_file.write_bytes(b"\x80\xff\xfe\x00\x01")

        state = load_session_state(state_dir)
        assert state == SessionState()

    def test_save_atomic_no_leftover_tmp(self, state_dir: Path):
        """After a successful save, no .tmp files should remain."""
        state_dir.mkdir(parents=True)
        state = SessionState(approval=ApprovalStateData(yolo=True))
        save_session_state(state, state_dir)

        tmp_files = list(state_dir.glob("*.tmp"))
        assert tmp_files == []

    def test_save_preserves_old_on_error(self, state_dir: Path, monkeypatch):
        """If writing fails, the original file should remain intact."""
        state_dir.mkdir(parents=True)
        original = SessionState(approval=ApprovalStateData(yolo=True))
        save_session_state(original, state_dir)

        # Monkey-patch json.dump to raise mid-write
        original_dump = json.dump

        def bad_dump(*args, **kwargs):
            original_dump(*args, **kwargs)
            raise OSError("simulated disk error")

        monkeypatch.setattr(json, "dump", bad_dump)

        with pytest.raises(OSError, match="simulated disk error"):
            save_session_state(SessionState(approval=ApprovalStateData(yolo=False)), state_dir)

        # Restore and verify original data is intact
        monkeypatch.undo()
        loaded = load_session_state(state_dir)
        assert loaded.approval.yolo is True

        # No leftover tmp files
        tmp_files = list(state_dir.glob("*.tmp"))
        assert tmp_files == []


class TestApprovalStateCallback:
    def test_notify_change_called_on_set_yolo(self):
        from kimi_cli.soul.approval import Approval, ApprovalState

        changes: list[bool] = []

        def on_change():
            changes.append(True)

        state = ApprovalState(on_change=on_change)
        approval = Approval(state=state)

        approval.set_yolo(True)
        assert len(changes) == 1
        assert state.yolo is True

        approval.set_yolo(False)
        assert len(changes) == 2
        assert state.yolo is False

    @pytest.mark.asyncio
    async def test_notify_change_called_on_approve_for_session(self):
        import asyncio

        from kimi_cli.soul.approval import Approval, ApprovalState
        from kimi_cli.soul.toolset import current_tool_call
        from kimi_cli.wire.types import ToolCall

        changes: list[bool] = []

        def on_change():
            changes.append(True)

        state = ApprovalState(on_change=on_change)
        approval = Approval(state=state)

        # Set up tool call context
        token = current_tool_call.set(
            ToolCall(id="test", function=ToolCall.FunctionBody(name="Shell", arguments=None))
        )
        try:
            # Start request in background
            request_task = asyncio.create_task(
                approval.request(sender="Shell", action="shell_exec", description="ls")
            )
            # Wait for the request to be queued
            request = await approval.fetch_request()
            approval.resolve_request(request.id, "approve_for_session")
            result = await request_task
        finally:
            current_tool_call.reset(token)

        assert result is True
        assert "shell_exec" in state.auto_approve_actions
        assert len(changes) == 1

    def test_no_callback_does_not_raise(self):
        from kimi_cli.soul.approval import Approval, ApprovalState

        state = ApprovalState()  # no on_change
        approval = Approval(state=state)
        approval.set_yolo(True)  # should not raise
        assert state.yolo is True
