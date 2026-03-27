"""E2E tests for ``@`` file mention auto-completion.

These tests verify that the file mention completer discovers files
correctly in a real PTY environment, including:
- Basic @ trigger and completion popup
- Scoped search with ``/`` prefix
- git ls-files integration (large repo simulation)
- Ignored directories (.git, node_modules) are filtered
"""

from __future__ import annotations

import subprocess
import sys
import time
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


def _init_git_repo(work_dir: Path) -> None:
    """Initialise a git repo, stage all files, and commit."""
    subprocess.run(["git", "init"], cwd=work_dir, capture_output=True, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=work_dir,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=work_dir,
        capture_output=True,
        check=True,
    )
    subprocess.run(["git", "add", "-A"], cwd=work_dir, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=work_dir,
        capture_output=True,
        check=True,
    )


def _setup_shell(tmp_path: Path, work_dir: Path):
    """Start a kimi-cli shell in PTY with a scripted (no-op) model."""
    home_dir = make_home_dir(tmp_path)
    config_path = write_scripted_config(tmp_path, scripts=["Hello!"])
    shell = start_shell_pty(
        config_path=config_path,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )
    # Wait for the welcome prompt
    read_until_prompt_ready(shell, after=0, timeout=20.0)
    return shell


def test_at_trigger_shows_top_level_entries(tmp_path: Path):
    """Typing ``@`` shows top-level files/directories."""
    work_dir = make_work_dir(tmp_path)
    (work_dir / "README.md").write_text("# Hello")
    (work_dir / "src").mkdir()
    (work_dir / "src" / "main.py").write_text("print('hi')")
    # Ignored dir — should NOT appear
    (work_dir / "node_modules").mkdir()
    (work_dir / "node_modules" / "junk.js").write_text("")

    shell = _setup_shell(tmp_path, work_dir)
    try:
        mark = shell.mark()
        shell.send_text("@")
        time.sleep(1.0)
        output = shell.wait_for_quiet(timeout=3.0, after=mark)

        # Should show real files
        assert "README.md" in output or "src/" in output, (
            f"Expected top-level entries in output, got:\n{output}"
        )
        # Should NOT show ignored dirs
        assert "node_modules" not in output, f"node_modules should be filtered, got:\n{output}"
    finally:
        shell.send_key("escape")
        shell.send_key("ctrl_c")
        shell.close()


def test_at_scoped_search_with_slash(tmp_path: Path):
    """Typing ``@src/`` shows files inside ``src/`` directory."""
    work_dir = make_work_dir(tmp_path)
    src = work_dir / "src"
    src.mkdir()
    (src / "app.py").write_text("# app")
    (src / "utils.py").write_text("# utils")
    # Another top-level dir
    (work_dir / "docs").mkdir()
    (work_dir / "docs" / "readme.md").write_text("")

    shell = _setup_shell(tmp_path, work_dir)
    try:
        mark = shell.mark()
        shell.send_text("@src/")
        time.sleep(1.0)
        output = shell.wait_for_quiet(timeout=3.0, after=mark)

        # Should show src/ contents
        assert "app.py" in output or "utils.py" in output, (
            f"Expected src/ contents in output, got:\n{output}"
        )
    finally:
        shell.send_key("escape")
        shell.send_key("ctrl_c")
        shell.close()


def test_git_ls_files_finds_deep_files(tmp_path: Path):
    """In a git repo, deep files are discoverable even with many early dirs."""
    work_dir = make_work_dir(tmp_path)

    # Create many early-alphabetical directories (would exhaust os.walk limit)
    for i in range(30):
        d = work_dir / f"aaa_{i:03d}"
        d.mkdir()
        for j in range(20):
            (d / f"file_{j}.txt").write_text(f"content {i}/{j}")

    # The target — late alphabetically
    target = work_dir / "zzz_target"
    target.mkdir()
    (target / "important.py").write_text("# find me")

    # Init git repo so git ls-files is used (files already created above).
    _init_git_repo(work_dir)

    shell = _setup_shell(tmp_path, work_dir)
    try:
        mark = shell.mark()
        shell.send_text("@zzz_target/")
        time.sleep(1.5)
        output = shell.wait_for_quiet(timeout=5.0, after=mark)

        assert "important.py" in output, f"Expected important.py via git ls-files, got:\n{output}"
    finally:
        shell.send_key("escape")
        shell.send_key("ctrl_c")
        shell.close()


def test_git_ignores_are_respected(tmp_path: Path):
    """Files in .gitignore should not appear in @ completion."""
    work_dir = make_work_dir(tmp_path)
    (work_dir / "visible.py").write_text("# visible")
    (work_dir / "secret.log").write_text("secret stuff")
    (work_dir / ".gitignore").write_text("*.log\n")

    _init_git_repo(work_dir)

    shell = _setup_shell(tmp_path, work_dir)
    try:
        mark = shell.mark()
        shell.send_text("@sec")
        time.sleep(1.5)
        output = shell.wait_for_quiet(timeout=3.0, after=mark)

        # secret.log is gitignored — should NOT appear
        assert "secret.log" not in output, f"secret.log should be gitignored, got:\n{output}"
    finally:
        shell.send_key("escape")
        shell.send_key("ctrl_c")
        shell.close()
