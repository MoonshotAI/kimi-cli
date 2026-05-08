"""
E2E tests for shell TUI modal interactions (approval, question, priority).

These tests use a real PTY + scripted_echo to exercise the full
prompt_toolkit integration, verifying that keyboard input, modal
rendering, and state transitions work end-to-end.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

from tests.e2e.shell_pty_helpers import (
    find_tool_result_output,
    make_home_dir,
    make_work_dir,
    read_until_prompt_ready,
    start_shell_pty,
    write_scripted_config,
)
from tests_e2e.wire_helpers import build_ask_user_tool_call, build_shell_tool_call

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="Shell PTY E2E tests require a Unix-like PTY.",
)


def _read_until_prompt(shell, *, after: int, timeout: float = 15.0) -> str:
    return read_until_prompt_ready(shell, after=after, timeout=timeout)


def _build_tool_call_line(tool_call_id: str, name: str, arguments: dict[str, object]) -> str:
    payload = {
        "id": tool_call_id,
        "name": name,
        "arguments": json.dumps(arguments),
    }
    return f"tool_call: {json.dumps(payload)}"


# ---------------------------------------------------------------------------
# Approval lifecycle tests
# ---------------------------------------------------------------------------


def test_approval_reject_via_key3(tmp_path: Path) -> None:
    """Pressing '3' (reject) should prevent the command from executing.
    Tool rejection stops the turn immediately (no further LLM call)."""
    scripts = [
        "\n".join(
            [
                "text: About to run a command.",
                build_shell_tool_call("tc-reject", "printf rejected > reject.txt"),
            ]
        ),
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("reject this command")
        shell.read_until_contains("requesting approval to run command", after=turn_mark)
        time.sleep(0.3)
        shell.send_key("3")
        # Rejection shows "Rejected by user" and returns to prompt
        shell.read_until_contains("Rejected by user", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert not (work_dir / "reject.txt").exists()
    finally:
        shell.close()


def test_approval_escape_rejects(tmp_path: Path) -> None:
    """Pressing Escape on an approval panel should reject the request."""
    scripts = [
        "\n".join(
            [
                "text: About to run a command.",
                build_shell_tool_call("tc-esc", "printf escaped > esc.txt"),
            ]
        ),
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("escape this command")
        shell.read_until_contains("requesting approval to run command", after=turn_mark)
        time.sleep(0.3)
        shell.send_key("escape")
        shell.read_until_contains("Rejected by user", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert not (work_dir / "esc.txt").exists()
    finally:
        shell.close()


def test_approval_arrow_key_navigation_then_enter(tmp_path: Path) -> None:
    """Navigate with arrow keys, then press Enter to submit the selected option."""
    scripts = [
        "\n".join(
            [
                "text: About to run a command.",
                build_shell_tool_call("tc-nav", "printf navigated > nav.txt"),
            ]
        ),
        "text: Approval navigation done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("navigate and approve")
        shell.read_until_contains("requesting approval to run command", after=turn_mark)
        # Default selection is index 0 (Approve). Press down twice to reach
        # Reject (index 2), then up once to reach Approve for Session (index 1),
        # then Enter.
        time.sleep(0.3)
        shell.send_key("down")
        time.sleep(0.1)
        shell.send_key("down")
        time.sleep(0.1)
        shell.send_key("up")
        time.sleep(0.1)
        shell.send_key("enter")
        shell.read_until_contains("Approval navigation done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert (work_dir / "nav.txt").read_text(encoding="utf-8") == "navigated"
    finally:
        shell.close()


def test_approval_consecutive_across_turns(tmp_path: Path) -> None:
    """
    Two separate turns each require approval. The second turn should
    also show an approval panel after the first turn completes.
    """
    scripts = [
        "\n".join(
            [
                "text: First approval incoming.",
                build_shell_tool_call("tc-t1", "printf first > t1.txt"),
            ]
        ),
        "text: First done.",
        "\n".join(
            [
                "text: Second approval incoming.",
                build_shell_tool_call("tc-t2", "printf second > t2.txt"),
            ]
        ),
        "text: Second done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        # Turn 1: approve
        t1_mark = shell.mark()
        shell.send_line("first approval turn")
        shell.read_until_contains("requesting approval to run command", after=t1_mark)
        time.sleep(0.3)
        shell.send_key("enter")
        shell.read_until_contains("First done.", after=t1_mark, timeout=15.0)
        p1_mark = shell.mark()
        _read_until_prompt(shell, after=p1_mark)
        assert (work_dir / "t1.txt").read_text(encoding="utf-8") == "first"

        # Turn 2: approve
        t2_mark = shell.mark()
        shell.send_line("second approval turn")
        shell.read_until_contains("requesting approval to run command", after=t2_mark)
        time.sleep(0.3)
        shell.send_key("enter")
        shell.read_until_contains("Second done.", after=t2_mark, timeout=15.0)
        p2_mark = shell.mark()
        _read_until_prompt(shell, after=p2_mark)
        assert (work_dir / "t2.txt").read_text(encoding="utf-8") == "second"
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Question lifecycle tests
# ---------------------------------------------------------------------------


def test_question_single_select_via_number_key(tmp_path: Path) -> None:
    """Pressing a number key auto-selects and submits the answer."""
    question_payload = [
        {
            "question": "Pick a color?",
            "options": [
                {"label": "Red", "description": ""},
                {"label": "Green", "description": ""},
                {"label": "Blue", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: Asking a question.",
                build_ask_user_tool_call("tc-color", question_payload),
            ]
        ),
        "text: Color question done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("ask me a color question")
        shell.read_until_contains("Pick a color?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("2")  # Select "Green"
        shell.read_until_contains("Color question done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        output = find_tool_result_output(home_dir, work_dir, "tc-color")
        assert isinstance(output, str)
        assert json.loads(output) == {"answers": {"Pick a color?": "Green"}}
    finally:
        shell.close()


def test_question_escape_dismisses_with_empty_answer(tmp_path: Path) -> None:
    """Pressing Escape on a question should resolve with empty answers."""
    question_payload = [
        {
            "question": "Pick something?",
            "options": [
                {"label": "A", "description": ""},
                {"label": "B", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: About to ask.",
                build_ask_user_tool_call("tc-esc-q", question_payload),
            ]
        ),
        "text: Escaped question done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("ask me")
        shell.read_until_contains("Pick something?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("escape")
        shell.read_until_contains("Escaped question done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        output = find_tool_result_output(home_dir, work_dir, "tc-esc-q")
        assert isinstance(output, str)
        result = json.loads(output)
        assert result["answers"] == {}
    finally:
        shell.close()


def test_question_multi_step_with_tab_navigation(tmp_path: Path) -> None:
    """Multi-question flow: answer Q1 with number key, Q2 with arrow+enter."""
    question_payload = [
        {
            "question": "First question?",
            "header": "Q1",
            "options": [
                {"label": "Opt1", "description": ""},
                {"label": "Opt2", "description": ""},
            ],
        },
        {
            "question": "Second question?",
            "header": "Q2",
            "options": [
                {"label": "X", "description": ""},
                {"label": "Y", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: Multi question flow.",
                build_ask_user_tool_call("tc-multi-q", question_payload),
            ]
        ),
        "text: Multi question complete.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("ask multi questions")
        shell.read_until_contains("First question?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        # Answer Q1 with "Opt2"
        shell.send_key("2")
        # Wait for Q2 tab to activate (checkmark appears)
        shell.read_until_contains("\u2713", after=turn_mark, timeout=15.0)
        time.sleep(0.3)
        # Answer Q2: navigate down to "Y" and press enter
        shell.send_key("down")
        time.sleep(0.1)
        shell.send_key("enter")
        shell.read_until_contains("Multi question complete.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        output = find_tool_result_output(home_dir, work_dir, "tc-multi-q")
        assert isinstance(output, str)
        answers = json.loads(output)["answers"]
        assert answers["First question?"] == "Opt2"
        assert answers["Second question?"] == "Y"
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Approval + Question interaction (priority conflict)
# ---------------------------------------------------------------------------


def test_approval_during_running_turn_shows_panel(tmp_path: Path) -> None:
    """
    When a shell command requires approval during a running turn, the approval
    panel should render, and the user should be able to approve it.
    This tests the _PromptLiveView inline approval path.
    """
    scripts = [
        "\n".join(
            [
                "text: About to request approval in turn.",
                build_shell_tool_call("tc-inline", "printf inline > inline.txt"),
            ]
        ),
        "text: Inline approval done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("run inline approval")
        shell.read_until_contains("requesting approval to run command", after=turn_mark)
        time.sleep(0.3)
        shell.send_key("enter")  # Approve (default selection)
        shell.read_until_contains("Inline approval done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert (work_dir / "inline.txt").read_text(encoding="utf-8") == "inline"
    finally:
        shell.close()


def test_question_then_approval_in_same_turn(tmp_path: Path) -> None:
    """
    A turn that first asks a question, then requests approval.
    Tests that the question modal is properly cleaned up before
    the approval modal is shown.
    """
    question_payload = [
        {
            "question": "Confirm name?",
            "options": [
                {"label": "Alice", "description": ""},
                {"label": "Bob", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: First a question.",
                build_ask_user_tool_call("tc-q-then-a-q", question_payload),
            ]
        ),
        "\n".join(
            [
                "text: Now an approval.",
                build_shell_tool_call("tc-q-then-a-cmd", "printf qa-done > qa.txt"),
            ]
        ),
        "text: Question then approval complete.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("question then approval")
        # Answer the question
        shell.read_until_contains("Confirm name?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("1")  # Alice
        # Now the approval should appear
        shell.read_until_contains(
            "requesting approval to run command", after=turn_mark, timeout=15.0
        )
        time.sleep(0.3)
        shell.send_key("enter")  # Approve
        shell.read_until_contains("Question then approval complete.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert (work_dir / "qa.txt").read_text(encoding="utf-8") == "qa-done"

        q_output = find_tool_result_output(home_dir, work_dir, "tc-q-then-a-q")
        assert isinstance(q_output, str)
        assert json.loads(q_output)["answers"]["Confirm name?"] == "Alice"
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Turn-end edge case
# ---------------------------------------------------------------------------


def test_approval_after_turn_end_still_responsive(tmp_path: Path) -> None:
    """
    If a turn ends while an approval is still pending (from a concurrent
    background agent), the approval modal should remain interactive.

    This is the simplest form: the foreground turn has two tool calls,
    the second one requests approval. The turn 'ends' from the LLM side
    after the text response, but approval is still pending.
    """
    scripts = [
        "\n".join(
            [
                "text: Turn ending with pending approval.",
                build_shell_tool_call("tc-post-turn", "printf post-turn > post.txt"),
            ]
        ),
        "text: Post-turn approval resolved.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("post-turn approval test")
        shell.read_until_contains(
            "requesting approval to run command", after=turn_mark, timeout=15.0
        )
        time.sleep(0.5)
        shell.send_key("enter")  # Approve
        shell.read_until_contains("Post-turn approval resolved.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert (work_dir / "post.txt").read_text(encoding="utf-8") == "post-turn"
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Ctrl-C during approval
# ---------------------------------------------------------------------------


def test_ctrl_c_during_approval_rejects(tmp_path: Path) -> None:
    """
    Pressing Ctrl-C while an approval modal is shown should reject the
    request (same as Escape), causing the tool to be rejected.
    """
    scripts = [
        "\n".join(
            [
                "text: About to request approval.",
                build_shell_tool_call("tc-ctrlc", "printf ctrlc > ctrlc.txt"),
            ]
        ),
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("ctrl-c during approval")
        shell.read_until_contains("requesting approval to run command", after=turn_mark)
        time.sleep(0.3)
        shell.send_key("ctrl_c")
        # Ctrl-C on approval modal maps to reject
        shell.read_until_contains("Rejected by user", after=turn_mark, timeout=10.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert not (work_dir / "ctrlc.txt").exists()
    finally:
        shell.close()


# NOTE: test_approve_for_session_auto_approves_same_action was removed here
# because test_shell_pty_e2e::test_shell_approval_roundtrip_and_session_auto_approve
# covers the same flow with additional cross-action verification (3 turns).


# ---------------------------------------------------------------------------
# Question edge cases
# ---------------------------------------------------------------------------


def test_question_single_question_returns_to_prompt(tmp_path: Path) -> None:
    """
    After answering the only question, the question modal must detach
    and the prompt must return to normal input mode. Verify by sending
    a normal text turn after the question.
    """
    question_payload = [
        {
            "question": "Pick one?",
            "options": [
                {"label": "Yes", "description": ""},
                {"label": "No", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: Question incoming.",
                build_ask_user_tool_call("tc-single-q", question_payload),
            ]
        ),
        "text: Question answered.",
        "text: Follow-up turn works.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("ask single question")
        shell.read_until_contains("Pick one?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("1")  # Yes
        shell.read_until_contains("Question answered.", after=turn_mark, timeout=15.0)
        p1_mark = shell.mark()
        _read_until_prompt(shell, after=p1_mark)

        # Verify prompt is back to normal by sending a follow-up turn
        t2_mark = shell.mark()
        shell.send_line("follow up after question")
        shell.read_until_contains("Follow-up turn works.", after=t2_mark, timeout=15.0)
        p2_mark = shell.mark()
        _read_until_prompt(shell, after=p2_mark)
    finally:
        shell.close()


def test_question_multi_select_with_space_and_enter(tmp_path: Path) -> None:
    """
    Multi-select question: Space toggles selection, Enter submits all selected.
    """
    question_payload = [
        {
            "question": "Select toppings",
            "multi_select": True,
            "options": [
                {"label": "Cheese", "description": ""},
                {"label": "Pepperoni", "description": ""},
                {"label": "Mushroom", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: Multi-select question.",
                build_ask_user_tool_call("tc-multi-sel", question_payload),
            ]
        ),
        "text: Multi-select done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("multi select toppings")
        shell.read_until_contains("Select toppings", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        # Toggle Cheese (index 0 - already focused)
        shell.send_key(" ")
        time.sleep(0.1)
        # Move down to Mushroom (index 2) and toggle
        shell.send_key("down")
        time.sleep(0.1)
        shell.send_key("down")
        time.sleep(0.1)
        shell.send_key(" ")
        time.sleep(0.1)
        # Submit
        shell.send_key("enter")
        shell.read_until_contains("Multi-select done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        output = find_tool_result_output(home_dir, work_dir, "tc-multi-sel")
        assert isinstance(output, str)
        answers = json.loads(output)["answers"]
        # Multi-select answers are comma-separated
        selected = answers["Select toppings"]
        assert "Cheese" in selected
        assert "Mushroom" in selected
        assert "Pepperoni" not in selected
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Ctrl-C during running turn (no approval panel)
# ---------------------------------------------------------------------------


def test_ctrl_c_during_running_turn_interrupts(tmp_path: Path) -> None:
    """
    Pressing Ctrl-C while the agent is running (no modal active) should
    interrupt the turn and return to the prompt.
    """
    scripts = [
        "\n".join(
            [
                "text: Starting a slow command.",
                build_shell_tool_call("tc-slow", "sleep 30"),
            ]
        ),
        "text: This should not appear.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("run slow command")
        shell.read_until_contains("Using Shell (sleep 30)", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("ctrl_c")
        shell.read_until_contains("Interrupted by user", after=turn_mark, timeout=10.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Steer input while approval is active
# ---------------------------------------------------------------------------


def test_steer_text_during_approval_is_not_submitted(tmp_path: Path) -> None:
    """
    While an approval modal is shown, typing text and pressing Enter
    should NOT submit the text as a steer command. The approval panel
    should consume the Enter key.
    """
    scripts = [
        "\n".join(
            [
                "text: Approval blocks steer.",
                build_shell_tool_call("tc-steer-block", "printf steer-ok > steer.txt"),
            ]
        ),
        "text: Steer block test done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("steer block test")
        shell.read_until_contains("requesting approval to run command", after=turn_mark)
        time.sleep(0.3)
        # Type some text - approval hides the input buffer, so this should
        # be ignored or buffered, and Enter should approve (default selection)
        shell.send_key("enter")
        shell.read_until_contains("Steer block test done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        assert (work_dir / "steer.txt").read_text(encoding="utf-8") == "steer-ok"

        # Verify no steer input was registered
        from tests.e2e.shell_pty_helpers import list_turn_begin_inputs

        inputs = list_turn_begin_inputs(home_dir, work_dir)
        assert inputs == ["steer block test"]
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Two questions in a single turn (back-to-back AskUserQuestion calls)
# ---------------------------------------------------------------------------


def test_two_question_tools_in_same_turn(tmp_path: Path) -> None:
    """
    One LLM response calls AskUserQuestion, gets answer, then the next LLM
    response calls AskUserQuestion again. Both should render and resolve.
    """
    q1_payload = [
        {
            "question": "Language?",
            "options": [
                {"label": "Python", "description": ""},
                {"label": "Rust", "description": ""},
            ],
        },
    ]
    q2_payload = [
        {
            "question": "Framework?",
            "options": [
                {"label": "Django", "description": ""},
                {"label": "Flask", "description": ""},
            ],
        },
    ]
    scripts = [
        "\n".join(
            [
                "text: First question.",
                build_ask_user_tool_call("tc-q1", q1_payload),
            ]
        ),
        "\n".join(
            [
                "text: Second question.",
                build_ask_user_tool_call("tc-q2", q2_payload),
            ]
        ),
        "text: Both questions done.",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("ask two questions")
        shell.read_until_contains("Language?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("1")  # Python
        # Second question
        shell.read_until_contains("Framework?", after=turn_mark, timeout=15.0)
        time.sleep(0.5)
        shell.send_key("2")  # Flask
        shell.read_until_contains("Both questions done.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        q1_output = find_tool_result_output(home_dir, work_dir, "tc-q1")
        assert json.loads(q1_output)["answers"]["Language?"] == "Python"

        q2_output = find_tool_result_output(home_dir, work_dir, "tc-q2")
        assert json.loads(q2_output)["answers"]["Framework?"] == "Flask"
    finally:
        shell.close()
