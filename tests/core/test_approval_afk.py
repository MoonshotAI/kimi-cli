"""Tests for Approval's yolo / afk orthogonal state model."""

from __future__ import annotations

from kimi_cli.soul.approval import Approval, ApprovalState


def test_yolo_only() -> None:
    approval = Approval(yolo=True)
    assert approval.is_yolo() is True
    assert approval.is_yolo_flag() is True
    assert approval.is_auto_approve() is True
    assert approval.is_afk() is False


def test_afk_only() -> None:
    state = ApprovalState(yolo=False, afk=True)
    approval = Approval(state=state)
    assert approval.is_auto_approve() is True
    assert approval.is_yolo() is False
    assert approval.is_yolo_flag() is False  # explicit flag only
    assert approval.is_afk() is True
    assert approval.is_afk_flag() is True


def test_yolo_and_afk() -> None:
    state = ApprovalState(yolo=True, afk=True)
    approval = Approval(state=state)
    assert approval.is_yolo() is True
    assert approval.is_auto_approve() is True
    assert approval.is_afk() is True


def test_neither_flag_set() -> None:
    approval = Approval(yolo=False)
    assert approval.is_yolo() is False
    assert approval.is_auto_approve() is False
    assert approval.is_afk() is False


def test_runtime_afk_only() -> None:
    state = ApprovalState(yolo=False, afk=False, runtime_afk=True)
    approval = Approval(state=state)
    assert approval.is_auto_approve() is True
    assert approval.is_yolo() is False
    assert approval.is_afk() is True
    assert approval.is_afk_flag() is False
    assert approval.is_runtime_afk() is True


def test_set_runtime_afk_does_not_trigger_on_change() -> None:
    fired: list[bool] = []
    state = ApprovalState(on_change=lambda: fired.append(True))
    approval = Approval(state=state)
    approval.set_runtime_afk(True)
    assert approval.is_afk() is True
    assert approval.is_afk_flag() is False
    assert fired == []


def test_set_yolo_does_not_touch_afk() -> None:
    state = ApprovalState(yolo=False, afk=True)
    approval = Approval(state=state)
    approval.set_yolo(True)
    assert approval.is_afk() is True
    assert approval.is_yolo() is True
    assert approval.is_auto_approve() is True
    approval.set_yolo(False)
    # Afk keeps auto-approve on even after the explicit yolo flag is cleared.
    assert approval.is_afk() is True
    assert approval.is_yolo() is False
    assert approval.is_auto_approve() is True


def test_shared_state_preserves_afk() -> None:
    state = ApprovalState(yolo=False, afk=True, runtime_afk=True)
    parent = Approval(state=state)
    child = parent.share()
    assert child.is_afk() is True
    assert child.is_yolo() is False
    assert child.is_auto_approve() is True
    assert child.is_runtime_afk() is True


def test_set_afk_toggles_with_on_change() -> None:
    """set_afk persists session afk and triggers on_change."""
    fired: list[bool] = []
    state = ApprovalState(yolo=False, afk=False, on_change=lambda: fired.append(True))
    approval = Approval(state=state)
    approval.set_afk(True)
    assert approval.is_afk() is True
    assert approval.is_afk_flag() is True
    assert fired == [True]
    approval.set_afk(False)
    assert approval.is_afk() is False
    assert approval.is_afk_flag() is False
    assert fired == [True, True]


def test_set_afk_false_clears_runtime_afk() -> None:
    state = ApprovalState(yolo=False, afk=False, runtime_afk=True)
    approval = Approval(state=state)
    assert approval.is_afk() is True
    approval.set_afk(False)
    assert approval.is_afk() is False
    assert approval.is_runtime_afk() is False
