from __future__ import annotations

from pathlib import Path

from kimi_cli.soul.approval import ApprovalState


def test_approval_state_persists(tmp_path: Path) -> None:
    state_file = tmp_path / "approval_state.json"
    state = ApprovalState(state_file=state_file)
    assert state.auto_approve_actions == set()

    state.add_auto_approve_action("WriteFile")
    assert state_file.exists()

    reloaded = ApprovalState(state_file=state_file)
    assert reloaded.auto_approve_actions == {"WriteFile"}
