"""Tests for session state persistence."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.session_state import (
    ApprovalStateData,
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
        assert state.custom_title is None
        assert state.title_generated is False
        assert state.title_generate_attempts == 0

    def test_save_and_load_roundtrip(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state = SessionState(
            approval=ApprovalStateData(
                yolo=True,
                auto_approve_actions={"Shell", "WriteFile"},
            ),
        )
        save_session_state(state, state_dir)

        loaded = load_session_state(state_dir)
        assert loaded.version == 1
        assert loaded.approval.yolo is True
        assert loaded.approval.auto_approve_actions == {"Shell", "WriteFile"}

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

    def test_custom_title_roundtrip(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state = SessionState(
            custom_title="My Session",
            title_generated=True,
            title_generate_attempts=1,
        )
        save_session_state(state, state_dir)

        loaded = load_session_state(state_dir)
        assert loaded.custom_title == "My Session"
        assert loaded.title_generated is True
        assert loaded.title_generate_attempts == 1

    def test_migrate_legacy_metadata(self, state_dir: Path):
        """Legacy metadata.json fields are migrated into state.json on load."""
        state_dir.mkdir(parents=True)
        metadata_file = state_dir / "metadata.json"
        metadata_file.write_text(
            json.dumps(
                {
                    "session_id": "test-id",
                    "title": "Legacy Title",
                    "title_generated": True,
                    "title_generate_attempts": 2,
                    "wire_mtime": 1234.5,
                    "archived": True,
                    "archived_at": 9999.0,
                    "auto_archive_exempt": True,
                }
            ),
            encoding="utf-8",
        )

        loaded = load_session_state(state_dir)
        assert loaded.custom_title == "Legacy Title"
        assert loaded.title_generated is True
        assert loaded.title_generate_attempts == 2
        assert loaded.wire_mtime == 1234.5
        assert loaded.archived is True
        assert loaded.archived_at == 9999.0
        assert loaded.auto_archive_exempt is True
        # metadata.json should be deleted after migration
        assert not metadata_file.exists()
        # state.json should have been written
        assert (state_dir / "state.json").exists()

    def test_migrate_legacy_metadata_does_not_overwrite_state(self, state_dir: Path):
        """Migration does not overwrite values already set in state.json."""
        state_dir.mkdir(parents=True)
        state = SessionState(custom_title="Already Set", title_generated=True)
        save_session_state(state, state_dir)

        metadata_file = state_dir / "metadata.json"
        metadata_file.write_text(
            json.dumps(
                {
                    "session_id": "test-id",
                    "title": "Old Metadata Title",
                    "title_generated": True,
                }
            ),
            encoding="utf-8",
        )

        loaded = load_session_state(state_dir)
        assert loaded.custom_title == "Already Set"
        assert not metadata_file.exists()

    def test_migrate_corrupted_metadata_leaves_file_intact(self, state_dir: Path):
        """Corrupted metadata.json is not deleted, left for future retry."""
        state_dir.mkdir(parents=True)
        metadata_file = state_dir / "metadata.json"
        metadata_file.write_text("not valid json {{{", encoding="utf-8")

        loaded = load_session_state(state_dir)
        # Should return defaults, not crash
        assert loaded.custom_title is None
        # Corrupted file should NOT be deleted
        assert metadata_file.exists()

    def test_migrate_empty_metadata_deletes_file(self, state_dir: Path):
        """metadata.json with only defaults should be cleaned up."""
        state_dir.mkdir(parents=True)
        metadata_file = state_dir / "metadata.json"
        metadata_file.write_text(
            json.dumps({"session_id": "test-id", "title": "Untitled"}),
            encoding="utf-8",
        )

        loaded = load_session_state(state_dir)
        assert loaded.custom_title is None  # "Untitled" is not migrated
        assert not metadata_file.exists()  # File cleaned up (no_change path)

    def test_migrate_writes_state_before_deleting_metadata(self, state_dir: Path):
        """state.json must exist after migration, even if metadata.json is gone."""
        state_dir.mkdir(parents=True)
        metadata_file = state_dir / "metadata.json"
        metadata_file.write_text(
            json.dumps(
                {
                    "session_id": "test-id",
                    "title": "Important Title",
                    "archived": True,
                }
            ),
            encoding="utf-8",
        )

        load_session_state(state_dir)
        state_file = state_dir / "state.json"
        assert state_file.exists()
        assert not metadata_file.exists()
        # Verify the state file actually has the migrated data
        data = json.loads(state_file.read_text(encoding="utf-8"))
        assert data["custom_title"] == "Important Title"
        assert data["archived"] is True

    def test_migrate_idempotent(self, state_dir: Path):
        """Calling load_session_state twice should give same result."""
        state_dir.mkdir(parents=True)
        metadata_file = state_dir / "metadata.json"
        metadata_file.write_text(
            json.dumps(
                {
                    "session_id": "test-id",
                    "title": "Migrated Title",
                    "archived": True,
                    "archived_at": 5555.0,
                }
            ),
            encoding="utf-8",
        )

        first = load_session_state(state_dir)
        second = load_session_state(state_dir)
        assert first.custom_title == second.custom_title == "Migrated Title"
        assert first.archived == second.archived is True
        assert first.archived_at == second.archived_at == 5555.0

    def test_new_fields_have_defaults(self, state_dir: Path):
        """Old state.json without new fields should load with defaults."""
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        state_file.write_text(
            json.dumps(
                {
                    "version": 1,
                    "approval": {"yolo": True, "auto_approve_actions": []},
                }
            ),
            encoding="utf-8",
        )

        loaded = load_session_state(state_dir)
        assert loaded.approval.yolo is True
        # New fields should have defaults
        assert loaded.custom_title is None
        assert loaded.title_generated is False
        assert loaded.archived is False
        assert loaded.wire_mtime is None

    def test_legacy_removed_subagent_field_is_ignored(self, state_dir: Path):
        state_dir.mkdir(parents=True)
        state_file = state_dir / "state.json"
        legacy_field = "dynamic_" + "subagents"
        state_file.write_text(
            json.dumps(
                {
                    "version": 1,
                    "approval": {"yolo": False, "auto_approve_actions": []},
                    legacy_field: [
                        {"name": "researcher", "system_prompt": "Research things."},
                        {"name": "coder", "system_prompt": "Write code."},
                    ],
                }
            ),
            encoding="utf-8",
        )

        loaded = load_session_state(state_dir)
        assert loaded == SessionState()

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
            while not approval.runtime.list_pending():
                await asyncio.sleep(0)
            request = approval.runtime.list_pending()[0]
            approval.runtime.resolve(request.id, "approve_for_session")
            result = await request_task
        finally:
            current_tool_call.reset(token)

        assert result.approved is True
        assert "shell_exec" in state.auto_approve_actions
        assert len(changes) == 1

    @pytest.mark.asyncio
    async def test_approve_for_session_resolves_already_pending_same_action(self):
        import asyncio

        from kimi_cli.soul.approval import Approval, ApprovalState
        from kimi_cli.soul.toolset import current_tool_call
        from kimi_cli.wire.types import ToolCall

        state = ApprovalState()
        approval = Approval(state=state)

        token = current_tool_call.set(
            ToolCall(id="test", function=ToolCall.FunctionBody(name="WriteFile", arguments=None))
        )
        try:
            first = asyncio.create_task(
                approval.request(sender="WriteFile", action="write_file", description="write one")
            )
            second = asyncio.create_task(
                approval.request(sender="WriteFile", action="write_file", description="write two")
            )
            while len(approval.runtime.list_pending()) < 2:
                await asyncio.sleep(0)
            pending = approval.runtime.list_pending()
            approval.runtime.resolve(pending[0].id, "approve_for_session")
            first_result = await first
            second_result = await second
            assert first_result.approved is True
            assert second_result.approved is True
        finally:
            current_tool_call.reset(token)

        assert "write_file" in state.auto_approve_actions
        assert approval.runtime.list_pending() == []

    def test_no_callback_does_not_raise(self):
        from kimi_cli.soul.approval import Approval, ApprovalState

        state = ApprovalState()  # no on_change
        approval = Approval(state=state)
        approval.set_yolo(True)  # should not raise
        assert state.yolo is True
