"""Tests for worktree CLI integration."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from kimi_cli.cli import cli


runner = CliRunner()


class TestWorktreeCliOptions:
    def test_help_shows_worktree_options(self) -> None:
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "--worktree" in result.output
        assert "--worktree-name" in result.output
        # Typer may truncate long option names in the help table
        assert "--worktree-bran" in result.output

    def test_worktree_conflicts_with_continue(self) -> None:
        result = runner.invoke(cli, ["--worktree", "--continue"])
        assert result.exit_code != 0
        assert "Cannot combine" in result.output
        assert "--worktree" in result.output
        assert "--continue" in result.output

    def test_worktree_conflicts_with_session(self) -> None:
        result = runner.invoke(cli, ["--worktree", "--session", "abc"])
        assert result.exit_code != 0
        assert "Cannot combine" in result.output
        assert "--worktree" in result.output
        assert "--session" in result.output

    def test_worktree_rejects_non_git_directory(self, tmp_path: Path) -> None:
        result = runner.invoke(cli, ["--worktree", "-w", str(tmp_path)])
        assert result.exit_code != 0
        assert "inside a git repository" in result.output

    def test_worktree_branch_without_worktree_is_allowed(self) -> None:
        """Currently we do not error on --worktree-branch without --worktree;
        the flag is simply ignored. This can be tightened later if desired."""
        result = runner.invoke(cli, ["--worktree-branch", "main", "--help"])
        assert result.exit_code == 0
