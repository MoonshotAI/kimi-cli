"""Git info API routes."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from kimi_cli.utils.subprocess_env import get_clean_env

router = APIRouter(prefix="/api/git", tags=["git"])

_GIT_TIMEOUT = 5.0


class GitInfo(BaseModel):
    """Lightweight git probe response for the web UI."""

    is_git_repo: bool = Field(..., description="Whether work_dir is inside a git repository")
    git_root: str | None = Field(default=None, description="Canonical git repository root")
    current_branch: str | None = Field(default=None, description="Current branch, None if detached")
    branches: list[str] = Field(default_factory=list, description="Local branch names")
    head_sha: str | None = Field(default=None, description="Short SHA of HEAD, None if no commits")


_EMPTY = GitInfo(is_git_repo=False)


async def _git(args: list[str], cwd: Path) -> tuple[str, int]:
    """Run a git command, return (stripped stdout, exit_code).

    Returns ("", 1) on timeout or any exception. Ensures the subprocess
    does not leak if the timeout fires.
    """
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=get_clean_env(),
        )
        stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=_GIT_TIMEOUT)
        return stdout_bytes.decode("utf-8", errors="replace").strip(), proc.returncode or 0
    except (TimeoutError, OSError):
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
        return "", 1


@router.get("/info", summary="Probe a directory for git info", response_model=GitInfo)
async def get_git_info(work_dir: str) -> GitInfo:
    """Return git repo info for the given work_dir."""
    try:
        path = Path(work_dir).expanduser().resolve()
    except (OSError, RuntimeError):
        return _EMPTY

    if not path.exists() or not path.is_dir():
        return _EMPTY

    root_stdout, root_code = await _git(["rev-parse", "--show-toplevel"], path)
    if root_code != 0 or not root_stdout:
        return _EMPTY

    git_root = str(Path(root_stdout).resolve())
    root_path = Path(git_root)

    branch_stdout, branch_code = await _git(
        ["symbolic-ref", "--quiet", "--short", "HEAD"], root_path
    )
    current_branch: str | None = branch_stdout if branch_code == 0 and branch_stdout else None

    head_stdout, head_code = await _git(["rev-parse", "--short", "HEAD"], root_path)
    head_sha: str | None = head_stdout if head_code == 0 and head_stdout else None

    branches_stdout, branches_code = await _git(
        ["branch", "--format=%(refname:short)"], root_path
    )
    branches: list[str] = (
        [line.strip() for line in branches_stdout.splitlines() if line.strip()]
        if branches_code == 0
        else []
    )

    return GitInfo(
        is_git_repo=True,
        git_root=git_root,
        current_branch=current_branch,
        branches=branches,
        head_sha=head_sha,
    )
