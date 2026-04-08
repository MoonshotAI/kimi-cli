"""E2E test: /sessions shows a message when no other sessions exist."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from tests.e2e.shell_pty_helpers import (
    make_home_dir,
    make_work_dir,
    read_until_prompt_ready,
    start_shell_pty,
    write_scripted_config,
)

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="Shell PTY E2E tests require a Unix-like PTY.",
)


def test_sessions_shows_no_other_sessions_message(tmp_path: Path) -> None:
    """When /sessions is invoked in a fresh session with no other sessions,
    it should print 'No other sessions found' and NOT show the picker."""
    config_path = write_scripted_config(tmp_path, ["text: Hello!"])
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
        read_until_prompt_ready(shell, after=prompt_mark)

        # Send the /sessions command
        sessions_mark = shell.mark()
        shell.send_line("/sessions")

        # Wait for the early-return message
        shell.read_until_contains("No other sessions found", after=sessions_mark)

        # Let the output settle, then capture
        output = shell.wait_for_quiet(timeout=5.0, quiet_period=0.5, after=sessions_mark)

        # The picker prompt must NOT appear
        assert "Select a session" not in output, (
            "The session picker should not appear when there are no other sessions"
        )
    finally:
        shell.close()
