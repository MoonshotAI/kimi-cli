"""Git operations utilities."""

from __future__ import annotations

import subprocess
from pathlib import Path


def run_git_command(repo_path: Path | str, cmd: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_path)] + cmd,
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Git command failed: {result.stderr}")

    return result.stdout.strip()


def get_diff(repo_path: Path | str, base_commit: str) -> str:
    return run_git_command(repo_path, ["diff", "--no-color", "--cached", base_commit])


def reset_hard(repo_path: Path | str) -> None:
    run_git_command(repo_path, ["reset", "--hard"])


def clean_all(repo_path: Path | str) -> None:
    run_git_command(repo_path, ["clean", "-fd"])


def checkout_commit(repo_path: Path | str, commit: str) -> None:
    run_git_command(repo_path, ["checkout", commit])


def add_all(repo_path: Path | str) -> None:
    run_git_command(repo_path, ["add", "-A"])


def get_status(repo_path: Path | str) -> str:
    return run_git_command(repo_path, ["status", "--porcelain"])

