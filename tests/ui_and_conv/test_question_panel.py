"""Tests for _QuestionRequestPanel state machine logic."""

from __future__ import annotations

from io import StringIO

from rich.console import Console

from kimi_cli.ui.shell.visualize import _QuestionRequestPanel
from kimi_cli.wire.types import QuestionItem, QuestionOption, QuestionRequest


def _render_to_str(panel: _QuestionRequestPanel) -> str:
    """Render the panel to a plain-text string via a Rich Console."""
    buf = StringIO()
    console = Console(file=buf, force_terminal=False, width=120)
    console.print(panel.render())
    return buf.getvalue()


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


def test_multi_select_other_cursor_not_on_other():
    """When Other is checked but cursor is elsewhere, should_prompt_other_input() should still return True."""
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

    # Move to Other (index 2) and toggle
    panel.move_down()  # index 1 (Cache)
    panel.move_down()  # index 2 (Other)
    panel.toggle_select()

    # Move cursor back to Auth (index 0) — cursor is NOT on Other
    panel.move_up()  # index 1
    panel.move_up()  # index 0
    assert not panel.is_other_selected

    # should_prompt_other_input() must still return True because Other is in _multi_selected
    assert panel.should_prompt_other_input() is True

    # submit() should return False (Other needs text input)
    assert panel.submit() is False


def test_multi_select_empty_submit_blocked():
    """Submitting with no options selected in multi-select mode should be blocked."""
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

    # Don't select anything, try to submit
    all_done = panel.submit()
    assert all_done is False

    # Answers should still be empty (nothing was stored)
    assert panel.get_answers() == {}


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


# ---------------------------------------------------------------------------
# Tab navigation
# ---------------------------------------------------------------------------


def _make_multi_question_request() -> QuestionRequest:
    """Helper: 3 questions with headers for tab navigation tests."""
    return _make_request(
        [
            {
                "question": "Q1?",
                "header": "Food",
                "options": [("Rice", ""), ("Noodle", ""), ("Bread", "")],
            },
            {
                "question": "Q2?",
                "header": "Drink",
                "options": [("Tea", ""), ("Coffee", "")],
            },
            {
                "question": "Q3?",
                "header": "Dessert",
                "options": [("Cake", ""), ("IceCream", "")],
                "multi_select": True,
            },
        ]
    )


def test_tab_navigation_no_wraparound():
    """prev_tab at first and next_tab at last should be no-ops."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    assert panel._current_question_index == 0
    panel.prev_tab()  # already at first — should stay
    assert panel._current_question_index == 0

    panel.go_to(2)
    assert panel._current_question_index == 2
    panel.next_tab()  # already at last — should stay
    assert panel._current_question_index == 2


def test_tab_navigation_preserves_cursor():
    """Switching tabs should save and restore cursor position."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Move cursor to option 2 on Q1
    panel.move_down()  # index 1
    panel.move_down()  # index 2
    assert panel._selected_index == 2

    # Switch to Q2
    panel.next_tab()
    assert panel._current_question_index == 1
    assert panel._selected_index == 0  # Q2 starts at 0

    # Move cursor on Q2
    panel.move_down()  # index 1
    assert panel._selected_index == 1

    # Switch back to Q1 — cursor should be restored to 2
    panel.prev_tab()
    assert panel._current_question_index == 0
    assert panel._selected_index == 2


def test_tab_navigation_preserves_multi_select():
    """Switching tabs should save and restore multi-select checkbox state."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Go to Q3 (multi-select)
    panel.go_to(2)
    assert panel.is_multi_select

    # Toggle Cake and IceCream
    panel.toggle_select()  # Cake
    panel.move_down()
    panel.toggle_select()  # IceCream
    assert panel._multi_selected == {0, 1}

    # Switch to Q1
    panel.prev_tab()
    assert panel._current_question_index == 1  # goes to Q2 (index 1), not Q1
    panel.prev_tab()
    assert panel._current_question_index == 0

    # Switch back to Q3 — multi-select state should be restored
    panel.go_to(2)
    assert panel._multi_selected == {0, 1}


def test_go_to_same_index_is_noop():
    """go_to(current_index) should not overwrite saved state."""
    panel = _QuestionRequestPanel(_make_multi_question_request())
    panel.move_down()
    panel.go_to(0)  # same index — should be no-op
    assert panel._selected_index == 1  # cursor unchanged


def test_go_to_out_of_bounds():
    """go_to with invalid index should be no-op."""
    panel = _QuestionRequestPanel(_make_multi_question_request())
    panel.go_to(-1)
    assert panel._current_question_index == 0
    panel.go_to(99)
    assert panel._current_question_index == 0


# ---------------------------------------------------------------------------
# Answer restoration after submission
# ---------------------------------------------------------------------------


def test_submit_clears_saved_selections():
    """After submit(), stale draft should be cleared so answer is used for restoration."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Move cursor to Noodle (index 1) on Q1, then switch to Q2 (saves draft)
    panel.move_down()  # index 1 (Noodle)
    panel.next_tab()  # saves draft {selected_index: 1} for Q1

    # Switch back to Q1, change to Bread (index 2), submit
    panel.prev_tab()
    assert panel._selected_index == 1  # restored from draft
    panel.move_down()  # index 2 (Bread)
    all_done = panel.submit()
    assert all_done is False  # Q2 and Q3 still pending

    # Verify the draft for Q1 is cleared
    assert 0 not in panel._saved_selections

    # Submit Q2 (default) and go to Q3
    all_done = panel.submit()
    assert all_done is False

    # Now go back to Q1 — should show Bread (from answer), not Noodle (stale draft)
    panel.go_to(0)
    assert panel._selected_index == 2  # Bread is at index 2


def test_submit_other_clears_saved_selections():
    """After submit_other(), stale draft should be cleared."""
    request = _make_request(
        [
            {"question": "Q1?", "options": [("A", ""), ("B", "")]},
            {"question": "Q2?", "options": [("C", ""), ("D", "")]},
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Move to Other on Q1
    panel.move_down()  # B
    panel.move_down()  # Other
    assert panel.is_other_selected

    # Switch to Q2 (saves draft with cursor on Other)
    panel.next_tab()

    # Switch back, submit with Other text
    panel.prev_tab()
    assert panel.is_other_selected  # restored from draft
    assert panel.submit() is False  # needs text
    panel.submit_other("custom")

    # Draft should be cleared
    assert 0 not in panel._saved_selections

    # Go back — should restore from answer, not stale draft
    panel.go_to(0)
    # "custom" doesn't match A or B, so it should be recognized as Other text
    # and cursor should land on the synthetic Other option.
    assert panel.is_other_selected


# ---------------------------------------------------------------------------
# Multi-select answer restoration from comma-separated string
# ---------------------------------------------------------------------------


def test_multi_select_answer_restoration():
    """Returning to a submitted multi-select question should restore checkboxes."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Go to Q3 (multi-select: Cake, IceCream)
    panel.go_to(2)

    # Select both options
    panel.toggle_select()  # Cake (index 0)
    panel.move_down()
    panel.toggle_select()  # IceCream (index 1)

    # Submit Q3
    all_done = panel.submit()
    assert all_done is False  # Q1 and Q2 still pending
    assert panel.get_answers()["Q3?"] == "Cake, IceCream"

    # Submit Q1 (now current after Q3 advance)
    panel.submit()  # Q1 default (Rice)

    # Submit Q2
    panel.submit()  # Q2 default (Tea)

    # Verify all answers
    answers = panel.get_answers()
    assert answers == {"Q1?": "Rice", "Q2?": "Tea", "Q3?": "Cake, IceCream"}


def test_multi_select_answer_restoration_after_revisit():
    """Revisiting a submitted multi-select question should show correct checkboxes."""
    request = _make_request(
        [
            {"question": "Q1?", "options": [("A", "")], "multi_select": True},
            {"question": "Q2?", "options": [("B", "")]},
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Select A and submit Q1
    panel.toggle_select()  # A
    panel.submit()  # → advances to Q2

    # Go back to Q1
    panel.go_to(0)

    # _multi_selected should contain {0} (A was checked)
    assert 0 in panel._multi_selected
    assert panel._selected_index == 0


def test_multi_select_answer_restoration_with_other():
    """Restoring multi-select with Other text should mark Other as selected."""
    request = _make_request(
        [
            {
                "question": "Pick?",
                "options": [("X", ""), ("Y", "")],
                "multi_select": True,
            },
            {"question": "Q2?", "options": [("Z", "")]},
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Select X and Other
    panel.toggle_select()  # X (index 0)
    panel.move_down()  # Y (index 1)
    panel.move_down()  # Other (index 2)
    panel.toggle_select()  # Other

    # submit() returns False (Other needs text)
    assert panel.submit() is False
    panel.submit_other("custom")

    assert panel.get_answers()["Pick?"] == "X, custom"

    # Go back to Q1
    panel.go_to(0)

    # X should be in _multi_selected, and Other (index 2) too
    assert 0 in panel._multi_selected  # X
    assert 2 in panel._multi_selected  # Other (because "custom" didn't match any known label)


def test_single_select_answer_restoration():
    """Revisiting a submitted single-select question should restore cursor."""
    request = _make_request(
        [
            {"question": "Q1?", "options": [("A", ""), ("B", ""), ("C", "")]},
            {"question": "Q2?", "options": [("D", ""), ("E", "")]},
        ]
    )
    panel = _QuestionRequestPanel(request)

    # Select B (index 1) and submit Q1
    panel.move_down()
    panel.submit()

    # Go back to Q1
    panel.go_to(0)
    assert panel._selected_index == 1  # B


# ---------------------------------------------------------------------------
# Multi-question advance logic
# ---------------------------------------------------------------------------


def test_advance_skips_answered_questions():
    """After submitting Q1, advance should go to Q2, not Q3 if Q2 is unanswered."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Submit Q1 default (Rice) → should advance to Q2
    panel.submit()
    assert panel._current_question_index == 1
    assert panel.current_question_text == "Q2?"

    # Submit Q2 default (Tea) → should advance to Q3
    panel.submit()
    assert panel._current_question_index == 2
    assert panel.current_question_text == "Q3?"


def test_advance_finds_first_unanswered():
    """After answering Q1 and Q3, submitting should cycle back to Q2."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Answer Q1
    panel.submit()  # Rice → advance to Q2
    assert panel._current_question_index == 1

    # Skip Q2 by tabbing to Q3
    panel.next_tab()
    assert panel._current_question_index == 2

    # Answer Q3 (multi-select: Cake)
    panel.toggle_select()
    panel.submit()

    # Should advance to Q2 (the only unanswered)
    assert panel._current_question_index == 1
    assert panel.current_question_text == "Q2?"


# ---------------------------------------------------------------------------
# Render validation
# ---------------------------------------------------------------------------


def test_render_does_not_crash():
    """render() should not raise for any state."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    # Render initial state
    _render_to_str(panel)

    # Render after some navigation
    panel.move_down()
    _render_to_str(panel)

    # Render on multi-select question
    panel.go_to(2)
    panel.toggle_select()
    _render_to_str(panel)

    # Render after submission
    panel.go_to(0)
    panel.submit()
    _render_to_str(panel)


def test_render_tab_bar_status():
    """Tab bar should show correct ●/✓/○ status indicators."""
    panel = _QuestionRequestPanel(_make_multi_question_request())

    rendered = _render_to_str(panel)

    # Q1 is active (●), Q2 and Q3 are unanswered (○)
    assert "\u25cf" in rendered  # ●
    assert "\u25cb" in rendered  # ○

    # Submit Q1, check Q1 shows ✓
    panel.submit()
    rendered = _render_to_str(panel)
    assert "\u2713" in rendered  # ✓


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_render_number_labels_in_single_select():
    """Single-select options should display [1], [2], etc. as literal text."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)
    rendered = _render_to_str(panel)

    # Number labels should appear as literal text, not be consumed as Rich markup
    assert "[1]" in rendered
    assert "[2]" in rendered
    assert "[3]" in rendered


def test_single_question_no_tab_bar():
    """Single-question request should not render tab bar."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)
    rendered = _render_to_str(panel)

    # No tab indicators since there's only one question
    assert "\u25cf" not in rendered


def test_header_fallback():
    """Questions without headers should use Q1, Q2, etc."""
    request = _make_request(
        [
            {"question": "First?", "options": [("A", "")]},
            {"question": "Second?", "options": [("B", "")]},
        ]
    )
    panel = _QuestionRequestPanel(request)
    rendered = _render_to_str(panel)
    assert "Q1" in rendered
    assert "Q2" in rendered


def test_submit_all_questions_returns_true():
    """Submitting the last unanswered question should return True."""
    request = _make_request(
        [
            {"question": "Q1?", "options": [("A", "")]},
            {"question": "Q2?", "options": [("B", "")]},
        ]
    )
    panel = _QuestionRequestPanel(request)

    assert panel.submit() is False  # Q2 still pending
    assert panel.submit() is True  # all done
    assert panel.get_answers() == {"Q1?": "A", "Q2?": "B"}


def test_toggle_select_noop_in_single_select():
    """toggle_select should do nothing in single-select mode."""
    request = _make_request()
    panel = _QuestionRequestPanel(request)

    panel.toggle_select()  # should be no-op
    assert panel._multi_selected == set()

    all_done = panel.submit()
    assert all_done is True
    assert panel.get_answers() == {"Pick one?": "A"}
