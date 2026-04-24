from __future__ import annotations

import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from tests.e2e.shell_pty_helpers import make_home_dir, make_work_dir, write_scripted_config
from tests_e2e.wire_helpers import repo_root

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("tmux") is None,
    reason="tmux E2E tests require tmux on a Unix-like platform.",
)


def _tmux(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["tmux", *args],
        check=check,
        text=True,
        capture_output=True,
    )


def _capture_pane(session: str) -> str:
    return _tmux("capture-pane", "-pt", f"{session}:0.0").stdout


def _wait_for_pane_text(session: str, text: str, *, timeout: float = 15.0) -> str:
    deadline = time.monotonic() + timeout
    last = ""
    while True:
        last = _capture_pane(session)
        if text in last:
            return last
        if time.monotonic() >= deadline:
            raise AssertionError(f"Timed out waiting for {text!r}.\nPane contents:\n{last}")
        time.sleep(0.1)


def _assert_pane_text_absent(session: str, text: str, *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        pane = _capture_pane(session)
        if text in pane:
            raise AssertionError(f"Unexpected text {text!r} appeared.\nPane contents:\n{pane}")
        if time.monotonic() >= deadline:
            return
        time.sleep(0.1)


def _write_skill(tmp_path: Path, *, name: str) -> Path:
    skill_root = tmp_path / "skills"
    skill_dir = skill_root / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_dir.joinpath("SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                "description: tmux slash completion test skill",
                "---",
                "",
                "Use this skill for slash completion tmux tests.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return skill_root


def _start_tmux_shell(
    *,
    session: str,
    config_path: Path,
    work_dir: Path,
    home_dir: Path,
    extra_args: list[str] | None = None,
    columns: int = 120,
    lines: int = 40,
) -> None:
    env = {
        "HOME": str(home_dir),
        "USERPROFILE": str(home_dir),
        "KIMI_SHARE_DIR": str(home_dir / ".kimi"),
        "KIMI_CLI_NO_AUTO_UPDATE": "1",
        "TERM": "xterm-256color",
        "COLUMNS": str(columns),
        "LINES": str(lines),
        "PYTHONUTF8": "1",
        "PROMPT_TOOLKIT_NO_CPR": "1",
    }
    command_parts = [
        sys.executable,
        "-m",
        "kimi_cli.cli",
        "--yolo",
        "--config-file",
        str(config_path),
        "--work-dir",
        str(work_dir),
    ]
    if extra_args:
        command_parts.extend(extra_args)
    command = shlex.join(command_parts)
    env_prefix = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())
    shell_command = f"cd {shlex.quote(str(repo_root()))} && {env_prefix} {command}"
    _tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        str(columns),
        "-y",
        str(lines),
        shell_command,
    )


def test_slash_completion_single_enter_executes(tmp_path: Path) -> None:
    """A single Enter accepts a slash-command completion and submits it.

    Regression test: previously, accepting a completion required extra Enter
    presses before the command would execute.
    """
    config_path = write_scripted_config(tmp_path, ["text: Hello!"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    session_name = f"kimi-tmux-slash-{uuid.uuid4().hex[:8]}"

    try:
        _start_tmux_shell(
            session=session_name,
            config_path=config_path,
            work_dir=work_dir,
            home_dir=home_dir,
        )
        _wait_for_pane_text(session_name, "Welcome to Kimi Code CLI!")
        _wait_for_pane_text(session_name, "── input")

        # Type "/session" (partial) to trigger completion menu.
        _tmux("send-keys", "-t", f"{session_name}:0.0", "/session", "")

        # Wait for completion menu to show "/sessions" candidate
        _wait_for_pane_text(session_name, "/sessions", timeout=5.0)

        # Single Enter: accept completion AND submit in one step.
        _tmux("send-keys", "-t", f"{session_name}:0.0", "Enter")

        # The /sessions command should execute immediately — showing
        # the full-screen session picker (SessionPickerApp).
        deadline = time.monotonic() + 10.0
        while True:
            pane = _capture_pane(session_name)
            if "SESSIONS" in pane or "No other sessions" in pane or "Select a session" in pane:
                break
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"Timed out waiting for /sessions output.\nPane contents:\n{pane}"
                )
            time.sleep(0.1)
    finally:
        _tmux("kill-session", "-t", session_name, check=False)


def test_skill_completion_enter_inserts_only_then_executes(tmp_path: Path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: skill command executed"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    skill_name = "tmux-skill"
    skills_dir = _write_skill(tmp_path, name=skill_name)
    session_name = f"kimi-tmux-skill-enter-{uuid.uuid4().hex[:8]}"

    try:
        _start_tmux_shell(
            session=session_name,
            config_path=config_path,
            work_dir=work_dir,
            home_dir=home_dir,
            extra_args=["--skills-dir", str(skills_dir)],
        )
        _wait_for_pane_text(session_name, "Welcome to Kimi Code CLI!")
        _wait_for_pane_text(session_name, "── input")

        _tmux("send-keys", "-t", f"{session_name}:0.0", f"/skill:{skill_name[:4]}", "")
        _wait_for_pane_text(session_name, f"/skill:{skill_name}", timeout=5.0)

        # Enter should only insert skill slash command from completion, not submit.
        _tmux("send-keys", "-t", f"{session_name}:0.0", "Enter")
        _assert_pane_text_absent(session_name, "skill command executed", timeout=2.0)
        _wait_for_pane_text(session_name, f"/skill:{skill_name}", timeout=2.0)

        # After appending user request and pressing Enter, command executes normally.
        _tmux("send-keys", "-t", f"{session_name}:0.0", " fix login", "Enter")
        _wait_for_pane_text(session_name, "skill command executed", timeout=10.0)
    finally:
        _tmux("kill-session", "-t", session_name, check=False)


def test_skill_completion_tab_does_not_submit(tmp_path: Path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: tab path executed"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    skill_name = "tmux-tab-skill"
    skills_dir = _write_skill(tmp_path, name=skill_name)
    session_name = f"kimi-tmux-skill-tab-{uuid.uuid4().hex[:8]}"

    try:
        _start_tmux_shell(
            session=session_name,
            config_path=config_path,
            work_dir=work_dir,
            home_dir=home_dir,
            extra_args=["--skills-dir", str(skills_dir)],
        )
        _wait_for_pane_text(session_name, "Welcome to Kimi Code CLI!")
        _wait_for_pane_text(session_name, "── input")

        _tmux("send-keys", "-t", f"{session_name}:0.0", "/skill:tmux-tab", "")
        _wait_for_pane_text(session_name, f"/skill:{skill_name}", timeout=5.0)
        _tmux("send-keys", "-t", f"{session_name}:0.0", "Tab")

        # Tab completion should not trigger slash execution by itself.
        _assert_pane_text_absent(session_name, "tab path executed", timeout=2.0)
    finally:
        _tmux("kill-session", "-t", session_name, check=False)
