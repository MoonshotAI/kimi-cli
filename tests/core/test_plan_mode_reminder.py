"""Tests for plan mode reminder detection in PlanModeInjectionProvider."""

from __future__ import annotations

from kosong.message import Message, TextPart

from kimi_cli.soul.dynamic_injections.plan_mode import (
    _full_reminder,
    _has_plan_reminder,
    _reentry_reminder,
    _sparse_reminder,
)


def _user_msg(text: str) -> Message:
    return Message(role="user", content=[TextPart(text=text)])


def test_detects_sparse_reminder() -> None:
    msg = _user_msg(f"<system-reminder>\n{_sparse_reminder()}\n</system-reminder>")
    assert _has_plan_reminder(msg)


def test_detects_sparse_reminder_with_path() -> None:
    msg = _user_msg(
        f"<system-reminder>\n{_sparse_reminder('/home/user/.kimi/plans/iron-man.md')}\n</system-reminder>"
    )
    assert _has_plan_reminder(msg)


def test_detects_full_reminder_without_path() -> None:
    msg = _user_msg(f"<system-reminder>\n{_full_reminder()}\n</system-reminder>")
    assert _has_plan_reminder(msg)


def test_detects_full_reminder_with_path() -> None:
    msg = _user_msg(
        f"<system-reminder>\n{_full_reminder('/home/user/.kimi/plans/iron-man.md')}\n</system-reminder>"
    )
    assert _has_plan_reminder(msg)


def test_detects_full_reminder_with_existing_plan() -> None:
    msg = _user_msg(
        f"<system-reminder>\n{_full_reminder('/home/user/.kimi/plans/batman.md', plan_exists=True)}\n</system-reminder>"
    )
    assert _has_plan_reminder(msg)


def test_does_not_match_unrelated_text() -> None:
    msg = _user_msg("Please review the plan and let me know.")
    assert not _has_plan_reminder(msg)


def test_does_not_match_assistant_message() -> None:
    # _has_plan_reminder only checks content, but caller filters by role.
    # Ensure the content check itself doesn't false-positive on similar text.
    msg = _user_msg("I will plan mode the project carefully.")
    assert not _has_plan_reminder(msg)


def test_detection_stays_in_sync_with_reminder_text() -> None:
    """Ensure that the detection keys are derived from the actual reminder functions.

    If someone changes the reminder wording, the detection must still work.
    This test verifies the contract: any text produced by _full_reminder or
    _sparse_reminder must be detectable by _has_plan_reminder.
    """
    for path in [None, "/tmp/plan.md", "/home/user/.kimi/plans/batman.md"]:
        for exists in [False, True]:
            full = _full_reminder(path, plan_exists=exists)
            assert _has_plan_reminder(_user_msg(full)), (
                f"Failed to detect _full_reminder(path={path!r}, plan_exists={exists})"
            )

    for path in [None, "/tmp/plan.md"]:
        sparse = _sparse_reminder(path)
        assert _has_plan_reminder(_user_msg(sparse)), (
            f"Failed to detect _sparse_reminder(path={path!r})"
        )


# --- Full Reminder content checks ---


def test_full_reminder_contains_only_exception() -> None:
    """Full reminder should clearly state plan file as the only exception."""
    text = _full_reminder("/tmp/plan.md")
    assert "with the exception of the plan file" in text
    assert "only file you are allowed to edit" in text


def test_full_reminder_contains_turn_ending_constraint() -> None:
    """Full reminder should constrain how turns end."""
    text = _full_reminder("/tmp/plan.md")
    assert "AskUserQuestion" in text
    assert "ExitPlanMode" in text
    assert "Do NOT end your turn any other way" in text


def test_full_reminder_contains_anti_pattern() -> None:
    """Full reminder should warn against asking about plan approval via AskUserQuestion."""
    text = _full_reminder()
    assert "user cannot see the plan until you call ExitPlanMode" in text


# --- Sparse Reminder content checks ---


def test_sparse_reminder_contains_turn_ending_constraint() -> None:
    """Sparse reminder should include turn ending instructions."""
    text = _sparse_reminder("/tmp/plan.md")
    assert "AskUserQuestion" in text
    assert "ExitPlanMode" in text
    assert "Never ask about plan approval" in text


def test_sparse_reminder_back_references_full() -> None:
    """Sparse reminder should reference the full instructions."""
    text = _sparse_reminder()
    assert "see full instructions earlier" in text


# --- Reentry Reminder ---


def test_reentry_reminder_contains_decision_tree() -> None:
    """Reentry reminder should include guidance on how to handle existing plan."""
    text = _reentry_reminder("/tmp/plan.md")
    assert "Re-entering Plan Mode" in text
    assert "different task" in text.lower()
    assert "same task" in text.lower()
    assert "Read the existing plan" in text
