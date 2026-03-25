from __future__ import annotations

import json
import sys
import textwrap
import time
from pathlib import Path

import pytest

from tests.e2e.shell_pty_helpers import (
    count_wire_messages,
    find_session_dir,
    find_tool_result_output,
    list_turn_begin_inputs,
    make_home_dir,
    make_work_dir,
    read_until_prompt_ready,
    start_shell_pty,
    wait_for_wire_message_count,
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


def _wait_for_background_task_status(
    session_dir: Path,
    *,
    expected_status: str,
    timeout: float = 15.0,
) -> Path:
    deadline = time.monotonic() + timeout
    tasks_root = session_dir / "tasks"
    last_seen: str | None = None
    while True:
        task_dirs = (
            [path for path in tasks_root.iterdir() if path.is_dir()] if tasks_root.exists() else []
        )
        if task_dirs:
            runtime_path = task_dirs[0] / "runtime.json"
            if runtime_path.exists():
                runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                status = runtime.get("status")
                last_seen = str(status)
                if status == expected_status:
                    return runtime_path
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"Timed out waiting for background task status {expected_status!r}. "
                f"Last seen: {last_seen!r}."
            )
        time.sleep(0.05)


def _exit_shell(shell) -> None:
    last_error: AssertionError | None = None
    for _ in range(2):
        exit_mark = shell.mark()
        shell.send_line("exit")
        try:
            shell.read_until_contains("Bye!", after=exit_mark, timeout=4.0)
            assert shell.wait() == 0
            return
        except AssertionError as exc:
            last_error = exc
            shell.wait_for_quiet(timeout=1.5, quiet_period=0.3, after=exit_mark)
    assert last_error is not None
    raise last_error


def test_shell_smoke_multiturn_scripted_echo(tmp_path: Path) -> None:
    config_path = write_scripted_config(
        tmp_path,
        [
            "text: Smoke turn one completed.",
            "text: Smoke turn two completed.",
        ],
    )
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
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        turn_one_mark = shell.mark()
        shell.send_line("run first smoke turn")
        shell.read_until_contains("Smoke turn one completed.", after=turn_one_mark)
        wait_for_wire_message_count(
            home_dir,
            work_dir,
            message_type="TurnEnd",
            expected_count=1,
        )
        first_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=first_prompt_mark)

        turn_two_mark = shell.mark()
        shell.send_line("run second smoke turn")
        shell.read_until_contains("Smoke turn two completed.", after=turn_two_mark)
        wait_for_wire_message_count(
            home_dir,
            work_dir,
            message_type="TurnEnd",
            expected_count=2,
        )
        second_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=second_prompt_mark)

        assert count_wire_messages(home_dir, work_dir, "TurnEnd") == 2
    finally:
        shell.close()


def test_shell_running_prompt_preserves_unsubmitted_draft(tmp_path: Path) -> None:
    scripts = [
        "\n".join(
            [
                "text: Running long task.",
                build_shell_tool_call("tc-draft", "sleep 1.5"),
            ]
        ),
        "text: First turn finished.",
        "text: Draft carried over.",
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

        first_turn_mark = shell.mark()
        shell.send_line("start long turn")
        shell.read_until_contains("Using Shell (sleep 1.5)", after=first_turn_mark, timeout=15.0)
        time.sleep(0.3)
        shell.send_text("follow-up draft")
        shell.read_until_contains("First turn finished.", after=first_turn_mark, timeout=15.0)
        first_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=first_prompt_mark)

        second_turn_mark = shell.mark()
        shell.send_key("enter")
        shell.read_until_contains("Draft carried over.", after=second_turn_mark, timeout=15.0)
        second_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=second_prompt_mark)

        assert list_turn_begin_inputs(home_dir, work_dir) == [
            "start long turn",
            "follow-up draft",
        ]
    finally:
        shell.close()


def test_shell_running_prompt_ignores_shift_tab_plan_toggle(tmp_path: Path) -> None:
    scripts = [
        "\n".join(
            [
                "text: Running long task.",
                build_shell_tool_call("tc-plan-mode", "sleep 1.5"),
            ]
        ),
        "text: First turn finished.",
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
        shell.send_line("start long turn")
        shell.read_until_contains("Using Shell (sleep 1.5)", after=turn_mark, timeout=15.0)
        shift_tab_mark = shell.mark()
        shell.send_key("s_tab")
        shell.read_until_contains("First turn finished.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        running_segment = shell.normalized_text()[shift_tab_mark:]
        assert "plan mode ON" not in running_segment
        assert "plan mode OFF" not in running_segment
    finally:
        shell.close()


def test_shell_exit_command_from_idle_prompt(tmp_path: Path) -> None:
    config_path = write_scripted_config(tmp_path, [])
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
        _exit_shell(shell)
    finally:
        shell.close()


def test_shell_shows_mcp_loading_without_blocking_input(tmp_path: Path) -> None:
    server_path = tmp_path / "slow_mcp_server.py"
    server_path.write_text(
        textwrap.dedent(
            """
            import time
            from fastmcp.server import FastMCP

            time.sleep(1.5)
            server = FastMCP("slow-mcp")

            @server.tool
            def ping(text: str) -> str:
                return f"pong:{{text}}"

            if __name__ == "__main__":
                server.run(transport="stdio", show_banner=False)
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    mcp_config_path = tmp_path / "mcp.json"
    mcp_config_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "slow-test": {
                        "command": sys.executable,
                        "args": [str(server_path)],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    config_path = write_scripted_config(tmp_path, [])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
        extra_args=["--mcp-config-file", str(mcp_config_path)],
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)
        shell.read_until_contains("MCP Servers:", after=prompt_mark, timeout=15.0)
        transcript = shell.normalized_text()[prompt_mark:]
        assert "slow-test" in transcript
        assert "(pending)" in transcript or "(connecting)" in transcript
        assert "ping" not in transcript

        _exit_shell(shell)
    finally:
        shell.close()


def test_shell_ctrl_d_from_idle_prompt_after_completed_turn_exits_cleanly(tmp_path: Path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: First turn finished."])
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
        shell.send_line("run first turn")
        shell.read_until_contains("First turn finished.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        eof_mark = shell.mark()
        shell.send_key("ctrl_d")
        shell.read_until_contains("Bye!", after=eof_mark, timeout=4.0)
        assert shell.wait() == 0
    finally:
        shell.close()


def test_shell_ctrl_c_from_idle_prompt_after_completed_turn_shows_tip(tmp_path: Path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: First turn finished."])
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
        shell.send_line("run first turn")
        shell.read_until_contains("First turn finished.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        interrupt_mark = shell.mark()
        shell.send_key("ctrl_c")
        shell.read_until_contains(
            "Tip: press Ctrl-D or send 'exit' to quit",
            after=interrupt_mark,
            timeout=4.0,
        )
        _read_until_prompt(shell, after=shell.mark())
    finally:
        shell.close()


def test_shell_question_roundtrip_with_other_answer(tmp_path: Path) -> None:
    question_payload = [
        {
            "question": "Pick a base option?",
            "header": "Base",
            "options": [
                {"label": "Alpha", "description": "Pick alpha"},
                {"label": "Beta", "description": "Pick beta"},
            ],
        },
        {
            "question": "Need anything else?",
            "header": "Extra",
            "options": [
                {"label": "Docs", "description": "Need docs"},
                {"label": "Tests", "description": "Need tests"},
            ],
        },
    ]
    config_path = write_scripted_config(
        tmp_path,
        [
            "\n".join(
                [
                    "text: About to ask questions.",
                    build_ask_user_tool_call("tc-q1", question_payload),
                ]
            ),
            "text: Question flow complete.",
        ],
    )
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
        shell.send_line("ask the interactive questions")
        # Wait for the complete question panel to render (including keyboard
        # hints at the bottom) before sending a key.  On slow CI runners,
        # prompt_toolkit may not be ready to process key bindings until the
        # full layout has been painted at least once.
        shell.read_until_contains("esc exit", after=turn_mark)
        # Small delay for prompt_toolkit's event loop to finish processing
        # the render and become ready for input.
        time.sleep(0.5)
        # Select "Beta" (option 2) for the first question.  The key press
        # auto-submits and the panel advances to Q2.  We wait for the "✓"
        # checkmark in the tab bar – prompt_toolkit's differential renderer
        # can fragment the full question text across cursor-positioning
        # escapes, so the literal "Need anything else?" may not survive
        # CSI stripping in the accumulated PTY transcript.
        shell.send_key("2")
        shell.read_until_contains("\u2713", after=turn_mark)
        # Select "Other" (option 3) for the second question
        shell.send_key("3")
        shell.send_key("enter")
        shell.read_until_contains(
            "Type your answer, then press Enter to submit.", after=turn_mark, timeout=15.0
        )
        shell.send_line("Custom follow-up")
        shell.read_until_contains("Question flow complete.", after=turn_mark, timeout=15.0)
        prompt_mark = shell.mark()
        _read_until_prompt(shell, after=prompt_mark)

        output = find_tool_result_output(home_dir, work_dir, "tc-q1")
        assert isinstance(output, str)
        assert json.loads(output) == {
            "answers": {
                "Pick a base option?": "Beta",
                "Need anything else?": "Custom follow-up",
            }
        }
    finally:
        shell.close()


def test_shell_approval_roundtrip_and_session_auto_approve(tmp_path: Path) -> None:
    scripts = [
        "\n".join(
            [
                "text: First approval incoming.",
                build_shell_tool_call("tc-a1", "printf first-approval > approval_one.txt"),
            ]
        ),
        "text: First approval done.",
        "\n".join(
            [
                "text: Second approval incoming.",
                build_shell_tool_call("tc-a2", "printf second-approval > approval_two.txt"),
            ]
        ),
        "text: Session approval saved.",
        "\n".join(
            [
                "text: Third shell action incoming.",
                build_shell_tool_call("tc-a3", "printf auto-approved > approval_three.txt"),
            ]
        ),
        "text: Third shell action completed.",
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

        first_mark = shell.mark()
        shell.send_line("run first approval flow")
        shell.read_until_contains("requesting approval to run command", after=first_mark)
        shell.send_key("enter")
        shell.read_until_contains("First approval done.", after=first_mark)
        first_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=first_prompt_mark)
        assert (work_dir / "approval_one.txt").read_text(encoding="utf-8") == "first-approval"

        second_mark = shell.mark()
        shell.send_line("run second approval flow")
        shell.read_until_contains("requesting approval to run command", after=second_mark)
        shell.send_key("2")
        shell.read_until_contains("Session approval saved.", after=second_mark)
        second_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=second_prompt_mark)
        assert (work_dir / "approval_two.txt").read_text(encoding="utf-8") == "second-approval"

        third_mark = shell.mark()
        shell.send_line("run third approval flow")
        shell.read_until_contains("Third shell action completed.", after=third_mark)
        third_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=third_prompt_mark)
        third_segment = shell.normalized_text()[third_mark:]
        assert "requesting approval to run command" not in third_segment
        assert (work_dir / "approval_three.txt").read_text(encoding="utf-8") == "auto-approved"
    finally:
        shell.close()


@pytest.mark.xfail(
    reason=(
        "Known bug: when an approval modal interrupts an existing draft, confirming the modal "
        "does not currently resolve the pending approval in the PTY flow."
    ),
    strict=False,
)
def test_shell_background_agent_approval_preserves_running_draft(tmp_path: Path) -> None:
    root_scripts_path = tmp_path / "root_scripts.json"
    sub_scripts_path = tmp_path / "sub_scripts.json"
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    target_path = work_dir / "bg_draft.txt"
    seed_path = work_dir / "seed.txt"
    seed_path.write_text(("seed line for delay\n" * 2000), encoding="utf-8")

    root_scripts_path.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root starts a background subagent.",
                        _build_tool_call_line(
                            "agent-bg-draft-1",
                            "Agent",
                            {
                                "description": "background draft write",
                                "prompt": (
                                    f"Write {target_path} with the word approved and then "
                                    "summarize."
                                ),
                                "subagent_type": "coder",
                                "model": "sub",
                                "run_in_background": True,
                            },
                        ),
                    ]
                ),
                "text: Root finished launching the background subagent.",
                "text: Draft preserved after approval.",
            ]
        ),
        encoding="utf-8",
    )
    sub_scripts_path.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Background subagent is preparing before approval.",
                        _build_tool_call_line(
                            "rf-draft-1",
                            "ReadFile",
                            {
                                "path": str(seed_path),
                            },
                        ),
                        _build_tool_call_line(
                            "rf-draft-2",
                            "ReadFile",
                            {
                                "path": str(seed_path),
                                "line_offset": 200,
                                "n_lines": 200,
                            },
                        ),
                    ]
                ),
                "\n".join(
                    [
                        "text: Background subagent will request approval now.",
                        _build_tool_call_line(
                            "wf-draft-1",
                            "WriteFile",
                            {
                                "path": str(target_path),
                                "content": "approved\n",
                            },
                        ),
                    ]
                ),
                # Pad the summary to exceed SUMMARY_MIN_LENGTH (200 chars) to avoid
                # a continuation turn that would exhaust the scripted provider.
                "text: Background subagent completed after approval. "
                + ("The file has been written successfully with the requested content. " * 4),
            ]
        ),
        encoding="utf-8",
    )

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "default_model": "root",
                "models": {
                    "root": {
                        "provider": "root_provider",
                        "model": "scripted_echo",
                        "max_context_size": 100000,
                    },
                    "sub": {
                        "provider": "sub_provider",
                        "model": "scripted_echo",
                        "max_context_size": 100000,
                    },
                },
                "providers": {
                    "root_provider": {
                        "type": "_scripted_echo",
                        "base_url": "",
                        "api_key": "",
                        "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(root_scripts_path)},
                    },
                    "sub_provider": {
                        "type": "_scripted_echo",
                        "base_url": "",
                        "api_key": "",
                        "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(sub_scripts_path)},
                    },
                },
            }
        ),
        encoding="utf-8",
    )

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
        shell.send_line("Launch a background agent that writes a file.")
        shell.read_until_contains(
            "Root finished launching the background subagent.",
            after=turn_mark,
            timeout=15.0,
        )
        draft_text = "keep this draft"
        shell.read_until_contains(
            "Root starts a background subagent.", after=turn_mark, timeout=15.0
        )
        shell.send_text(draft_text)
        approval_mark = shell.mark()
        shell.read_until_contains(
            "requesting approval to edit file",
            after=approval_mark,
            timeout=15.0,
        )
        approval_segment = shell.normalized_text()[approval_mark:]
        assert "WriteFile is requesting approval to edit file" in approval_segment

        shell.send_key("enter")
        shell.read_until_contains(
            "Root finished launching the background subagent.",
            after=turn_mark,
            timeout=15.0,
        )
        session_dir = find_session_dir(home_dir, work_dir)
        runtime_path = _wait_for_background_task_status(
            session_dir,
            expected_status="completed",
            timeout=15.0,
        )
        assert target_path.read_text(encoding="utf-8") == "approved\n"

        prompt_after_approval = shell.mark()
        _read_until_prompt(shell, after=prompt_after_approval)
        shell.send_key("enter")
        shell.read_until_contains("Draft preserved after approval.", after=prompt_after_approval)
        next_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=next_prompt_mark)

        assert list_turn_begin_inputs(home_dir, work_dir) == [
            "Launch a background agent that writes a file.",
            draft_text,
        ]

        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
        assert runtime["failure_reason"] is None
    finally:
        shell.close()


def test_shell_approval_reject_and_recover(tmp_path: Path) -> None:
    scripts = [
        "\n".join(
            [
                "text: Reject path incoming.",
                build_shell_tool_call("tc-r1", "printf rejected > should_not_exist.txt"),
            ]
        ),
        "text: Recovery turn completed.",
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

        reject_mark = shell.mark()
        shell.send_line("reject this shell action")
        shell.read_until_contains(
            "requesting approval to run command", after=reject_mark, timeout=15.0
        )
        shell.send_key("3")
        # Wait for the tool call to be fully processed (confirmed by "Used Shell" marker)
        # before looking for the prompt, to avoid matching ✨ from a mid-turn redraw.
        shell.read_until_contains("Used Shell", after=reject_mark, timeout=15.0)
        reject_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=reject_prompt_mark)
        assert not (work_dir / "should_not_exist.txt").exists()

        recovery_mark = shell.mark()
        shell.send_line("prove recovery works")
        shell.read_until_contains("Recovery turn completed.", after=recovery_mark, timeout=15.0)
        recovery_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=recovery_prompt_mark)
    finally:
        shell.close()


def test_shell_mode_toggle_roundtrip(tmp_path: Path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: Agent mode recovered."])
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

        toggle_mark = shell.mark()
        shell.send_key("ctrl_x")
        shell.wait_for_quiet(after=toggle_mark)
        shell.send_line("printf shell-mode-ok")
        shell.read_until_contains("shell-mode-ok", after=toggle_mark)
        shell_prompt_mark = shell.mark()
        shell.read_until_contains("$", after=shell_prompt_mark)
        shell.wait_for_quiet(after=shell_prompt_mark)

        toggle_back_mark = shell.mark()
        shell.send_key("ctrl_x")
        shell.wait_for_quiet(after=toggle_back_mark)

        agent_mark = shell.mark()
        shell.send_line("return to agent mode")
        shell.read_until_contains("Agent mode recovered.", after=agent_mark)
        agent_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=agent_prompt_mark)

        assert list_turn_begin_inputs(home_dir, work_dir) == ["return to agent mode"]
    finally:
        shell.close()


def test_shell_session_resume_and_replay(tmp_path: Path) -> None:
    first_config_path = write_scripted_config(tmp_path, ["text: Replay first assistant line."])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    first_shell = start_shell_pty(
        config_path=first_config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )

    try:
        first_shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(first_shell, after=first_shell.mark())

        first_turn_mark = first_shell.mark()
        first_shell.send_line("remember-session-replay")
        first_shell.read_until_contains("Replay first assistant line.", after=first_turn_mark)
        _read_until_prompt(first_shell, after=first_turn_mark)
    finally:
        first_shell.close()

    session_id = find_session_dir(home_dir, work_dir).name
    resume_root = tmp_path / "resume"
    resume_root.mkdir()
    second_config_path = write_scripted_config(
        resume_root,
        ["text: Replay second assistant line."],
    )
    second_shell = start_shell_pty(
        config_path=second_config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
        extra_args=["--session", session_id],
    )

    try:
        second_shell.read_until_contains("Welcome to Kimi Code CLI!")
        second_shell.read_until_contains("remember-session-replay")
        second_shell.read_until_contains("Replay first assistant line.")
        _read_until_prompt(second_shell, after=second_shell.mark())

        second_turn_mark = second_shell.mark()
        second_shell.send_line("continue-after-replay")
        second_shell.read_until_contains("Replay second assistant line.", after=second_turn_mark)
        second_prompt_mark = second_shell.mark()
        _read_until_prompt(second_shell, after=second_prompt_mark)
    finally:
        second_shell.close()


@pytest.mark.skip(reason="/clear triggers Reload which hangs the process in inline prompt mode")
def test_shell_clear_reloads_without_replaying_old_turns(tmp_path: Path) -> None:
    config_path = write_scripted_config(
        tmp_path,
        [
            "text: Before clear result.",
            "text: After clear result.",
        ],
    )
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

        before_mark = shell.mark()
        shell.send_line("history-before-clear")
        shell.read_until_contains("Before clear result.", after=before_mark)
        _read_until_prompt(shell, after=before_mark)

        clear_mark = shell.mark()
        shell.send_line("/clear")
        shell.read_until_contains("The context has been cleared.", after=clear_mark)
        shell.read_until_contains("Welcome to Kimi Code CLI!", after=clear_mark)
        clear_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=clear_prompt_mark)

        post_clear_segment = shell.normalized_text()[clear_mark:]
        assert "history-before-clear" not in post_clear_segment
        assert "Before clear result." not in post_clear_segment

        after_mark = shell.mark()
        shell.send_line("history-after-clear")
        shell.read_until_contains("Before clear result.", after=after_mark)
        after_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=after_prompt_mark)

        assert list_turn_begin_inputs(home_dir, work_dir) == [
            "history-before-clear",
            "/clear",
            "history-after-clear",
        ]
    finally:
        shell.close()


def test_shell_cancel_running_command_kills_process_and_recovers(tmp_path: Path) -> None:
    scripts = [
        build_shell_tool_call("tc-c1", "sleep 2 && printf should-not-exist > cancel_output.txt"),
        "text: Cancel recovery completed.",
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

        cancel_mark = shell.mark()
        shell.send_line("start cancellable command")
        shell.read_until_contains("Using Shell (sleep 2 && printf should-", after=cancel_mark)
        shell.send_key("escape")
        shell.read_until_contains("Interrupted by user", after=cancel_mark)
        cancel_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=cancel_prompt_mark)

        time.sleep(2.3)
        assert not (work_dir / "cancel_output.txt").exists()

        recovery_mark = shell.mark()
        shell.send_line("confirm cancellation recovery")
        shell.read_until_contains("Cancel recovery completed.", after=recovery_mark)
        recovery_prompt_mark = shell.mark()
        _read_until_prompt(shell, after=recovery_prompt_mark)
    finally:
        shell.close()
