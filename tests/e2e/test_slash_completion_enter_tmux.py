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
    return _tmux("capture-pane", "-pS", "-", "-t", f"{session}:0.0").stdout


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


def _start_tmux_shell(
    *,
    session: str,
    config_path: Path,
    work_dir: Path,
    home_dir: Path,
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
