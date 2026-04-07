"""
PTY-based E2E smoke tests for the subagent rework.

Covers:
  1. Foreground Agent (coder) — basic round trip
  2. Foreground Agent (Explore) — read-only subagent type
  3. Background Agent — launch, complete, check session artifacts
  4. Agent tool unavailable for subagents — nested spawn blocked
  5. Resume — foreground agent resume by agent_id
  6. Multi-turn — root launches two foreground agents in sequence
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="Shell PTY E2E tests require a Unix-like PTY.",
)

from tests.e2e.shell_pty_helpers import (  # noqa: E402
    ShellPTYProcess,
    find_session_dir,
    make_home_dir,
    make_work_dir,
    read_until_prompt_ready,
    start_shell_pty,
)

LONG_PAD = "This is a padded summary to exceed the minimum length threshold. " * 5

PROMPT_SYMBOL = "── input"


def _build_tool_call_line(tool_call_id: str, name: str, arguments: dict) -> str:
    payload = {"id": tool_call_id, "name": name, "arguments": json.dumps(arguments)}
    return f"tool_call: {json.dumps(payload)}"


def _read_until_prompt(shell: ShellPTYProcess, *, after: int) -> str:
    return read_until_prompt_ready(shell, after=after)


def _wait_for_background_task_status(
    session_dir: Path, *, expected_status: str, timeout: float = 20.0
) -> Path:
    deadline = time.monotonic() + timeout
    tasks_root = session_dir / "tasks"
    last_seen: str | None = None
    while True:
        task_dirs = [p for p in tasks_root.iterdir() if p.is_dir()] if tasks_root.exists() else []
        if task_dirs:
            runtime_path = task_dirs[0] / "runtime.json"
            if runtime_path.exists():
                runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                status = runtime.get("status")
                last_seen = str(status)
                if status == expected_status:
                    return runtime_path
        if time.monotonic() >= deadline:
            # Dump diagnostics
            debug = ""
            if task_dirs:
                rt = task_dirs[0] / "runtime.json"
                if rt.exists():
                    debug += f"\nruntime.json: {rt.read_text()}"
                out = task_dirs[0] / "output.log"
                if out.exists():
                    debug += f"\noutput.log (tail): {out.read_text()[-600:]}"
            raise AssertionError(
                f"Timed out waiting for background task {expected_status!r}. "
                f"Last seen: {last_seen!r}.{debug}"
            )
        time.sleep(0.05)


def _make_two_provider_config(
    tmp_path: Path,
    root_scripts_path: Path,
    sub_scripts_path: Path,
) -> Path:
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
    return config_path


# ---------------------------------------------------------------------------
# Test 1: Foreground coder agent — basic round trip
# ---------------------------------------------------------------------------


def test_foreground_coder_agent(tmp_path: Path) -> None:
    """Root launches a foreground coder subagent that reads a file."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    target = work_dir / "hello.txt"
    target.write_text("smoke test content\n", encoding="utf-8")

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root dispatching to coder agent.",
                        _build_tool_call_line(
                            "fg-1",
                            "Agent",
                            {
                                "description": "read hello",
                                "prompt": f"Read {target} and tell me what it says.",
                                "subagent_type": "coder",
                                "model": "sub",
                            },
                        ),
                    ]
                ),
                "text: Root received the coder result.",
            ]
        ),
        encoding="utf-8",
    )
    sub_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Sub reading file.",
                        _build_tool_call_line(
                            "rf-1",
                            "ReadFile",
                            {"path": str(target)},
                        ),
                    ]
                ),
                f"text: The file contains smoke test content. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
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
        shell.send_line("Run the coder agent to read hello.txt")
        shell.read_until_contains("Root received the coder result.", after=turn_mark, timeout=15.0)
        _read_until_prompt(shell, after=turn_mark)

        # Verify session artifacts
        session_dir = find_session_dir(home_dir, work_dir)
        subagents_root = session_dir / "subagents"
        assert subagents_root.exists(), "subagents/ directory should exist"
        agent_dirs = [d for d in subagents_root.iterdir() if d.is_dir()]
        assert len(agent_dirs) == 1, f"Expected 1 subagent dir, got {agent_dirs}"
        agent_dir = agent_dirs[0]
        meta = json.loads((agent_dir / "meta.json").read_text(encoding="utf-8"))
        assert meta["subagent_type"] == "coder"
        assert meta["status"] == "idle"  # completed foreground returns to idle
        assert (agent_dir / "context.jsonl").exists()
        assert (agent_dir / "wire.jsonl").exists()
        assert (agent_dir / "prompt.txt").exists()
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Test 2: Foreground Explore agent — read-only type
# ---------------------------------------------------------------------------


def test_foreground_explore_agent(tmp_path: Path) -> None:
    """Root launches an Explore subagent that uses Glob."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    (work_dir / "a.py").write_text("print('a')\n")
    (work_dir / "b.py").write_text("print('b')\n")

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root dispatching to Explore agent.",
                        _build_tool_call_line(
                            "fg-explore-1",
                            "Agent",
                            {
                                "description": "list py files",
                                "prompt": f"List all .py files in {work_dir}.",
                                "subagent_type": "explore",
                                "model": "sub",
                            },
                        ),
                    ]
                ),
                "text: Root received Explore result.",
            ]
        ),
        encoding="utf-8",
    )
    sub_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Explore listing files.",
                        _build_tool_call_line(
                            "glob-1",
                            "Glob",
                            {"pattern": "*.py", "path": str(work_dir)},
                        ),
                    ]
                ),
                f"text: Found a.py and b.py in the directory. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
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
        shell.send_line("List py files via Explore agent")
        shell.read_until_contains("Root received Explore result.", after=turn_mark, timeout=15.0)
        _read_until_prompt(shell, after=turn_mark)

        session_dir = find_session_dir(home_dir, work_dir)
        agent_dirs = list((session_dir / "subagents").iterdir())
        assert len(agent_dirs) == 1
        meta = json.loads((agent_dirs[0] / "meta.json").read_text(encoding="utf-8"))
        assert meta["subagent_type"] == "explore"
        assert meta["status"] == "idle"
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Test 3: Background agent — launch, complete, verify artifacts
# ---------------------------------------------------------------------------


def test_background_agent_completes(tmp_path: Path) -> None:
    """Root launches a background coder subagent that writes a file."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    target = work_dir / "bg_output.txt"

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root launching background agent.",
                        _build_tool_call_line(
                            "bg-1",
                            "Agent",
                            {
                                "description": "bg write file",
                                "prompt": f"Write '{target}' with 'bg-done'.",
                                "subagent_type": "coder",
                                "model": "sub",
                                "run_in_background": True,
                            },
                        ),
                    ]
                ),
                "text: Root done launching background agent.",
            ]
        ),
        encoding="utf-8",
    )
    sub_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Background agent writing file.",
                        _build_tool_call_line(
                            "wf-bg-1",
                            "WriteFile",
                            {"path": str(target), "content": "bg-done\n"},
                        ),
                    ]
                ),
                f"text: Background agent wrote the file successfully. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
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
        shell.send_line("Launch background agent to write file")
        shell.read_until_contains(
            "Root done launching background agent.", after=turn_mark, timeout=15.0
        )
        shell.wait_for_quiet(timeout=3.0, after=turn_mark)

        session_dir = find_session_dir(home_dir, work_dir)
        _wait_for_background_task_status(session_dir, expected_status="completed")

        assert target.exists(), "Background agent should have written the file"
        assert target.read_text(encoding="utf-8") == "bg-done\n"

        # Verify subagent store
        agent_dirs = list((session_dir / "subagents").iterdir())
        assert len(agent_dirs) == 1
        meta = json.loads((agent_dirs[0] / "meta.json").read_text(encoding="utf-8"))
        assert meta["subagent_type"] == "coder"
        assert meta["status"] == "idle"  # completed background returns to idle
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Test 4: Sequential foreground agents — two agents in one session
# ---------------------------------------------------------------------------


def test_sequential_foreground_agents(tmp_path: Path) -> None:
    """Root launches two foreground agents in sequence, each gets own subagent dir."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                # Turn 1: first agent
                "\n".join(
                    [
                        "text: Root dispatching first agent.",
                        _build_tool_call_line(
                            "fg-seq-1",
                            "Agent",
                            {
                                "description": "first task",
                                "prompt": "Say hello.",
                                "subagent_type": "coder",
                                "model": "sub",
                            },
                        ),
                    ]
                ),
                "text: First agent done.",
                # Turn 2: second agent
                "\n".join(
                    [
                        "text: Root dispatching second agent.",
                        _build_tool_call_line(
                            "fg-seq-2",
                            "Agent",
                            {
                                "description": "second task",
                                "prompt": "Say goodbye.",
                                "subagent_type": "explore",
                                "model": "sub",
                            },
                        ),
                    ]
                ),
                "text: Second agent done.",
            ]
        ),
        encoding="utf-8",
    )
    sub_scripts.write_text(
        json.dumps(
            [
                # First agent response
                f"text: Hello from the first coder agent. {LONG_PAD}",
                # Second agent response
                f"text: Goodbye from the Explore agent. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        # Turn 1
        mark1 = shell.mark()
        shell.send_line("Run first agent")
        shell.read_until_contains("First agent done.", after=mark1, timeout=15.0)
        _read_until_prompt(shell, after=mark1)

        # Turn 2
        mark2 = shell.mark()
        shell.send_line("Run second agent")
        shell.read_until_contains("Second agent done.", after=mark2, timeout=15.0)
        _read_until_prompt(shell, after=mark2)

        # Verify two separate subagent directories
        session_dir = find_session_dir(home_dir, work_dir)
        agent_dirs = sorted((session_dir / "subagents").iterdir(), key=lambda p: p.name)
        assert len(agent_dirs) == 2, f"Expected 2 subagent dirs, got {len(agent_dirs)}"

        types = set()
        for d in agent_dirs:
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            types.add(meta["subagent_type"])
            assert meta["status"] == "idle"
        assert types == {"coder", "explore"}
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Test 5: Background agent with approval — non-yolo mode
# ---------------------------------------------------------------------------


def test_background_agent_with_approval(tmp_path: Path) -> None:
    """Background agent requests approval, user approves, agent completes."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    target = work_dir / "approved.txt"

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root starts background agent.",
                        _build_tool_call_line(
                            "bg-appr-1",
                            "Agent",
                            {
                                "description": "bg approval test",
                                "prompt": f"Write {target} with 'approved-content'.",
                                "subagent_type": "coder",
                                "model": "sub",
                                "run_in_background": True,
                            },
                        ),
                    ]
                ),
                "text: Root finished starting background agent.",
            ]
        ),
        encoding="utf-8",
    )
    sub_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Background agent writing with approval.",
                        _build_tool_call_line(
                            "wf-appr-1",
                            "WriteFile",
                            {"path": str(target), "content": "approved-content\n"},
                        ),
                    ]
                ),
                f"text: Background agent completed after writing. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,  # Approval required
    )

    try:
        shell.read_until_contains("Welcome to Kimi Code CLI!")
        _read_until_prompt(shell, after=shell.mark())

        turn_mark = shell.mark()
        shell.send_line("Start background agent that writes a file.")
        # Wait for the approval request from the background agent
        shell.read_until_contains("requesting approval to edit file", after=turn_mark, timeout=15.0)
        # Approve it
        shell.send_key("enter")
        shell.read_until_contains(
            "Root finished starting background agent.", after=turn_mark, timeout=15.0
        )
        shell.wait_for_quiet(timeout=5.0, after=turn_mark)

        session_dir = find_session_dir(home_dir, work_dir)
        runtime_path = _wait_for_background_task_status(session_dir, expected_status="completed")
        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
        assert runtime["failure_reason"] is None

        assert target.read_text(encoding="utf-8") == "approved-content\n"

        # Verify subagent store and output log (merged from former pty test)
        agent_dirs = list((session_dir / "subagents").iterdir())
        assert len(agent_dirs) == 1
        meta = json.loads((agent_dirs[0] / "meta.json").read_text(encoding="utf-8"))
        assert meta["subagent_type"] == "coder"
        assert meta["status"] == "idle"
        output_content = (agent_dirs[0] / "output").read_text(encoding="utf-8")
        assert "[stage] run_soul_start" in output_content
        assert "Background agent writing with approval." in output_content
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Test 6: Summary continuation — short response triggers extra turn
# ---------------------------------------------------------------------------


def test_summary_continuation_triggers_on_short_response(tmp_path: Path) -> None:
    """When a foreground subagent's initial response is shorter than
    SUMMARY_MIN_LENGTH (200 chars), the runner should automatically send
    a continuation prompt.  The sub provider receives 3 calls:
      1. tool call + short text
      2. short text (still too brief but continuation has only 1 attempt)
    Since SUMMARY_CONTINUATION_ATTEMPTS=1, only one extra turn is attempted.
    We provide exactly 3 scripts for the sub provider (turn 1 = tool + result,
    turn 2 = short initial response, turn 3 = continuation response)."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    target = work_dir / "cont.txt"

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root dispatching to agent.",
                        _build_tool_call_line(
                            "fg-cont-1",
                            "Agent",
                            {
                                "description": "continuation test",
                                "prompt": f"Write {target} and summarize.",
                                "subagent_type": "coder",
                                "model": "sub",
                            },
                        ),
                    ]
                ),
                "text: Root done with continuation test.",
            ]
        ),
        encoding="utf-8",
    )
    # Sub provider scripts:
    #   Script 1 (step 1): tool call to write the file + short text
    #   Script 2 (step 2 = initial response after tool): SHORT text (<200 chars)
    #     → triggers continuation
    #   Script 3 (continuation turn): longer response
    sub_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Writing file now.",
                        _build_tool_call_line(
                            "wf-cont-1",
                            "WriteFile",
                            {"path": str(target), "content": "continuation-test\n"},
                        ),
                    ]
                ),
                # Intentionally short — will trigger summary continuation.
                "text: Done.",
                # Continuation response — must be long enough (>200 chars).
                f"text: Here is the detailed summary of what happened. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
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
        shell.send_line("Run continuation test")
        shell.read_until_contains(
            "Root done with continuation test.", after=turn_mark, timeout=20.0
        )
        _read_until_prompt(shell, after=turn_mark)

        # Verify file was written.
        assert target.read_text(encoding="utf-8") == "continuation-test\n"

        # Verify the subagent completed successfully despite the short initial
        # response — the continuation mechanism should have extended it.
        session_dir = find_session_dir(home_dir, work_dir)
        agent_dirs = list((session_dir / "subagents").iterdir())
        assert len(agent_dirs) == 1
        meta = json.loads((agent_dirs[0] / "meta.json").read_text(encoding="utf-8"))
        assert meta["status"] == "idle", (
            f"Subagent should be idle after continuation, got {meta['status']}"
        )

        # Verify the subagent's context.jsonl contains multiple assistant
        # messages (the short initial one + the continuation one).
        ctx_path = agent_dirs[0] / "context.jsonl"
        ctx_lines = [
            line for line in ctx_path.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        assistant_msgs = [
            json.loads(line) for line in ctx_lines if json.loads(line).get("role") == "assistant"
        ]
        assert len(assistant_msgs) >= 2, (
            f"Expected at least 2 assistant messages (initial + continuation), "
            f"got {len(assistant_msgs)}"
        )
    finally:
        shell.close()


# ---------------------------------------------------------------------------
# Test 7: Summary continuation — response already long enough skips extra turn
# ---------------------------------------------------------------------------


def test_no_continuation_when_response_is_long(tmp_path: Path) -> None:
    """When the sub agent's response is already >= 200 chars, no continuation
    turn should be attempted.  We provide exactly 2 scripts for the sub provider.
    If a third turn were attempted, the scripted provider would raise an error."""
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    root_scripts = tmp_path / "root_scripts.json"
    sub_scripts = tmp_path / "sub_scripts.json"

    root_scripts.write_text(
        json.dumps(
            [
                "\n".join(
                    [
                        "text: Root dispatching.",
                        _build_tool_call_line(
                            "fg-nocont-1",
                            "Agent",
                            {
                                "description": "no continuation",
                                "prompt": "Just greet me.",
                                "subagent_type": "coder",
                                "model": "sub",
                            },
                        ),
                    ]
                ),
                "text: Root done.",
            ]
        ),
        encoding="utf-8",
    )
    # Only 1 sub script — if continuation were triggered, provider would crash.
    sub_scripts.write_text(
        json.dumps(
            [
                f"text: Hello from the sub agent. {LONG_PAD}",
            ]
        ),
        encoding="utf-8",
    )

    config_path = _make_two_provider_config(tmp_path, root_scripts, sub_scripts)
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
        shell.send_line("Run no-continuation test")
        shell.read_until_contains("Root done.", after=turn_mark, timeout=15.0)
        _read_until_prompt(shell, after=turn_mark)

        session_dir = find_session_dir(home_dir, work_dir)
        agent_dirs = list((session_dir / "subagents").iterdir())
        assert len(agent_dirs) == 1
        meta = json.loads((agent_dirs[0] / "meta.json").read_text(encoding="utf-8"))
        assert meta["status"] == "idle"
    finally:
        shell.close()
