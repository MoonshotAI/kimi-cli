"""Tests for Approval's yolo / afk orthogonal state model."""

from __future__ import annotations

from kimi_cli.soul.approval import Approval, ApprovalState


def test_yolo_only() -> None:
    approval = Approval(yolo=True)
    assert approval.is_yolo() is True
    assert approval.is_yolo_flag() is True
    assert approval.is_afk() is False


def test_afk_only() -> None:
    state = ApprovalState(yolo=False, afk=True)
    approval = Approval(state=state)
    assert approval.is_yolo() is True  # OR'ed with afk
    assert approval.is_yolo_flag() is False  # explicit flag only
    assert approval.is_afk() is True


def test_yolo_and_afk() -> None:
    state = ApprovalState(yolo=True, afk=True)
    approval = Approval(state=state)
    assert approval.is_yolo() is True
    assert approval.is_afk() is True


def test_neither_flag_set() -> None:
    approval = Approval(yolo=False)
    assert approval.is_yolo() is False
    assert approval.is_afk() is False


def test_set_yolo_does_not_touch_afk() -> None:
    state = ApprovalState(yolo=False, afk=True)
    approval = Approval(state=state)
    approval.set_yolo(True)
    assert approval.is_afk() is True
    assert approval.is_yolo() is True
    approval.set_yolo(False)
    # Afk keeps is_yolo() True even after the explicit flag is cleared.
    assert approval.is_afk() is True
    assert approval.is_yolo() is True


def test_shared_state_preserves_afk() -> None:
    state = ApprovalState(yolo=False, afk=True)
    parent = Approval(state=state)
    child = parent.share()
    assert child.is_afk() is True
    assert child.is_yolo() is True


def test_set_afk_toggles_without_on_change() -> None:
    """set_afk must NOT trigger on_change (afk is runtime-only, not persisted)."""
    fired: list[bool] = []
    state = ApprovalState(yolo=False, afk=False, on_change=lambda: fired.append(True))
    approval = Approval(state=state)
    approval.set_afk(True)
    assert approval.is_afk() is True
    assert fired == []  # on_change must stay silent
    approval.set_afk(False)
    assert approval.is_afk() is False
    assert fired == []
