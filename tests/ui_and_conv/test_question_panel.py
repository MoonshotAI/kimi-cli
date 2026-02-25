"""Tests for _QuestionRequestPanel state machine logic."""

from __future__ import annotations

from kimi_cli.ui.shell.visualize import _QuestionRequestPanel
from kimi_cli.wire.types import QuestionItem, QuestionOption, QuestionRequest


def _make_request(
    questions: list[dict] | None = None,
) -> QuestionRequest:
    """Helper to build a QuestionRequest from simplified dicts."""
    if questions is None:
        questions = [
            {
                "question": "Pick one?",
                "options": [("A", "desc A"), ("B", "desc B"), ("C", "desc C")],
                "multi_select": False,
            }
        ]
    items = []
    for q in questions:
        items.append(
            QuestionItem(
                question=q["question"],
                header=q.get("header", ""),
                options=[QuestionOption(label=lab, description=d) for lab, d in q["options"]],
                multi_select=q.get("multi_select", False),
            )
        )
    return QuestionRequest(id="qr-test", tool_call_id="tc-test", questions=items)


def test_single_select_submit():
    """Default selection (index 0) should submit the first option."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)

    # Default selected_index is 0, submit should complete all questions
    all_done = panel.submit()
    assert all_done is True
    assert panel.get_answers() == {"Pick one?": "A"}


def test_single_select_navigate_and_submit():
    """Navigate down twice and submit should select the third option."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)

    panel.move_down()
    panel.move_down()
    all_done = panel.submit()
    assert all_done is True
    assert panel.get_answers() == {"Pick one?": "C"}


def test_single_select_other():
    """Selecting 'Other' should require custom text input."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)

    # Move to Other (last option = index 3: A, B, C, Other)
    panel.move_down()  # index 1 (B)
    panel.move_down()  # index 2 (C)
    panel.move_down()  # index 3 (Other)
    assert panel.is_other_selected

    # submit() returns False because Other needs text input
    all_done = panel.submit()
    assert all_done is False

    # Provide custom text
    all_done = panel.submit_other("custom text")
    assert all_done is True
    assert panel.get_answers() == {"Pick one?": "custom text"}


def test_multi_select_toggle_and_submit():
    """Toggle options 0 and 2, submit should produce comma-joined labels."""
    request = _make_request(
        [
            {
                "question": "Select many?",
                "options": [("X", ""), ("Y", ""), ("Z", "")],
                "multi_select": True,
            }
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Toggle option 0
    panel.toggle_select()  # cursor at 0, toggle X
    # Move to option 2 and toggle
    panel.move_down()  # cursor at 1
    panel.move_down()  # cursor at 2
    panel.toggle_select()  # toggle Z

    all_done = panel.submit()
    assert all_done is True
    assert panel.get_answers() == {"Select many?": "X, Z"}


def test_multi_select_with_other():
    """Multi-select with Other selected should require text, then combine."""
    request = _make_request(
        [
            {
                "question": "Features?",
                "options": [("Auth", ""), ("Cache", "")],
                "multi_select": True,
            }
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Toggle Auth (index 0)
    panel.toggle_select()

    # Move to Other (index 2: Auth, Cache, Other) and toggle
    panel.move_down()  # index 1 (Cache)
    panel.move_down()  # index 2 (Other)
    panel.toggle_select()

    # submit() returns False because Other is selected
    all_done = panel.submit()
    assert all_done is False

    # Provide custom text
    all_done = panel.submit_other("extra feature")
    assert all_done is True
    assert panel.get_answers() == {"Features?": "Auth, extra feature"}


def test_multi_question_advance():
    """Multi-question panel should advance through questions."""
    request = _make_request(
        [
            {
                "question": "Q1?",
                "options": [("A1", ""), ("B1", "")],
            },
            {
                "question": "Q2?",
                "options": [("A2", ""), ("B2", "")],
            },
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Submit first question (default selection = A1)
    all_done = panel.submit()
    assert all_done is False  # still have Q2

    # Navigate to second option for Q2
    panel.move_down()
    all_done = panel.submit()
    assert all_done is True

    answers = panel.get_answers()
    assert answers == {"Q1?": "A1", "Q2?": "B2"}


def test_wrap_around_navigation():
    """move_up at first option should wrap to the last option (Other)."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)

    # At index 0, move_up should wrap to last (Other at index 3)
    panel.move_up()
    assert panel.is_other_selected

    # move_down from last should wrap to first (index 0)
    panel.move_down()
    assert not panel.is_other_selected
    # Verify it's at index 0 by submitting
    all_done = panel.submit()
    assert all_done is True
    assert panel.get_answers() == {"Pick one?": "A"}
