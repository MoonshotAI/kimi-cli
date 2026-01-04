import subprocess
import os


def run_git_command(repo_path: str, cmd: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_path)] + cmd,
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Git command failed: {result.stderr}")

    return result.stdout.strip()


def get_diff(repo_path: str, base_commit: str) -> str:
    return run_git_command(repo_path, ["diff", "--no-color", "--cached", base_commit])


def reset_hard(repo_path: str) -> None:
    run_git_command(repo_path, ["reset", "--hard"])


def clean_all(repo_path: str) -> None:
    run_git_command(repo_path, ["clean", "-fd"])


def checkout_commit(repo_path: str, commit: str) -> None:
    run_git_command(repo_path, ["checkout", commit])


def add_all(repo_path: str) -> None:
    run_git_command(repo_path, ["add", "-A"])


def get_status(repo_path: str) -> str:
    return run_git_command(repo_path, ["status", "--porcelain"])

