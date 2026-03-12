"""Tests for additional_dirs session state persistence and restoration."""

from __future__ import annotations

import json
from pathlib import Path

from kimi_cli.session_state import SessionState, load_session_state, save_session_state


def test_session_state_default_additional_dirs():
    """New session state should have empty additional_dirs."""
    state = SessionState()
    assert state.additional_dirs == []


def test_session_state_serialization(tmp_path: Path):
    """additional_dirs should persist through save/load cycle."""
    state = SessionState()
    state.additional_dirs = ["/home/user/lib", "/opt/shared"]
    save_session_state(state, tmp_path)

    loaded = load_session_state(tmp_path)
    assert loaded.additional_dirs == ["/home/user/lib", "/opt/shared"]


def test_session_state_backward_compatibility(tmp_path: Path):
    """Old state.json without additional_dirs field should load with empty list."""
    old_state = {"version": 1, "approval": {"yolo": False, "auto_approve_actions": []}}
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps(old_state))

    loaded = load_session_state(tmp_path)
    assert loaded.additional_dirs == []


def test_session_state_preserves_other_fields(tmp_path: Path):
    """Saving additional_dirs should not corrupt other fields."""
    state = SessionState()
    state.approval.yolo = True
    state.additional_dirs = ["/extra"]
    save_session_state(state, tmp_path)

    loaded = load_session_state(tmp_path)
    assert loaded.approval.yolo is True
    assert loaded.additional_dirs == ["/extra"]
