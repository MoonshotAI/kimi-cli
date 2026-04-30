"""Git worktree management for isolated agent sessions."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path

import kaos
from kaos.path import KaosPath

from kimi_cli.utils.logging import logger

_TIMEOUT = 30.0


class WorktreeError(Exception):
    """Raised when a git worktree operation fails."""

    def __init__(self, message: str, stderr: str | None = None) -> None:
        super().__init__(message)
        self.stderr = stderr


async def find_git_root(path: KaosPath) -> KaosPath | None:
    """Find the git repository root containing *path*.

    Returns ``None`` if *path* is not inside a git repository.
    """
    cwd = str(path)
    result = await _run_git(["rev-parse", "--show-toplevel"], cwd)
    if result is None:
        return None
    return KaosPath(result).canonical()


async def create_worktree(
    repo_root: KaosPath,
    name: str | None = None,
    branch: str | None = None,
) -> KaosPath:
    """Create a new git worktree for an agent session.

    Args:
        repo_root: Absolute path to the git repository root.
        name: Optional directory name for the worktree. Auto-generated if omitted.
        branch: Optional branch to check out. If omitted, the worktree is created
            in a detached HEAD state at the current HEAD.

    Returns:
        The absolute path of the newly created worktree directory.

    Raises:
        WorktreeError: If the worktree cannot be created.
    """
    repo_root = repo_root.canonical()

    # Auto-generate name if not provided
    if name is None:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        name = f"kimi-{timestamp}"

    # Ensure .kimi directory exists at repo root
    kimi_dir = Path(str(repo_root)) / ".kimi"
    kimi_dir.mkdir(parents=True, exist_ok=True)

    worktrees_dir = kimi_dir / "worktrees"
    worktrees_dir.mkdir(parents=True, exist_ok=True)

    worktree_path = worktrees_dir / name

    if worktree_path.exists():
        raise WorktreeError(
            f"Worktree directory already exists: {worktree_path}\n"
            f"Use --worktree-name to choose a different name, or remove the existing directory."
        )

    args = ["worktree", "add"]
    if branch is not None:
        args.extend([str(worktree_path), branch])
    else:
        args.extend(["--detach", str(worktree_path)])

    stdout, stderr, exit_code = await _run_git_raw(args, str(repo_root))

    if exit_code != 0:
        # Clean up partial directory if git created it
        if worktree_path.exists():
            await asyncio.to_thread(_rmtree_sync, Path(str(worktree_path)))
        raise WorktreeError(
            f"Failed to create git worktree at {worktree_path}\n"
            f"git stderr: {stderr or '(no output)'}"
        )

    logger.info(
        "Created git worktree: {path} (repo: {repo})",
        path=worktree_path,
        repo=repo_root,
    )
    return KaosPath.unsafe_from_local_path(worktree_path)


async def remove_worktree(repo_root: KaosPath, worktree_path: KaosPath) -> None:
    """Remove a git worktree and its directory.

    Uses ``git worktree remove`` if the worktree is registered with git,
    otherwise falls back to plain directory removal.
    """
    repo_root = repo_root.canonical()
    worktree_path = worktree_path.canonical()

    # Try git worktree remove first
    stdout, stderr, exit_code = await _run_git_raw(
        ["worktree", "remove", str(worktree_path)],
        str(repo_root),
    )

    if exit_code != 0:
        # Git may complain if the worktree is not registered; fall back to rm
        logger.warning(
            "git worktree remove failed ({code}), falling back to rmtree: {stderr}",
            code=exit_code,
            stderr=stderr,
        )
        if Path(str(worktree_path)).exists():
            await asyncio.to_thread(_rmtree_sync, Path(str(worktree_path)))
    else:
        logger.info(
            "Removed git worktree: {path}",
            path=worktree_path,
        )

    # Also prune stale worktree metadata
    await _run_git_raw(["worktree", "prune"], str(repo_root))


async def list_worktrees(repo_root: KaosPath) -> list[dict[str, str]]:
    """List registered git worktrees for the repository.

    Returns a list of dicts with keys ``path`` and ``branch``.
    """
    repo_root = repo_root.canonical()
    result = await _run_git(["worktree", "list", "--porcelain"], str(repo_root))
    if result is None:
        return []

    worktrees: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in result.splitlines():
        if line.startswith("worktree "):
            if current:
                worktrees.append(current)
            current = {"path": line[len("worktree "):].strip()}
        elif line.startswith("branch "):
            current["branch"] = line[len("branch "):].strip()
        elif line.startswith("detached"):
            current["branch"] = "(detached HEAD)"
    if current:
        worktrees.append(current)
    return worktrees


async def _run_git(args: list[str], cwd: str, timeout: float = _TIMEOUT) -> str | None:
    """Run a git command and return stripped stdout, or None on failure."""
    stdout, stderr, exit_code = await _run_git_raw(args, cwd, timeout)
    if exit_code != 0:
        return None
    return stdout.strip() if stdout else ""


async def _run_git_raw(
    args: list[str],
    cwd: str,
    timeout: float = _TIMEOUT,
) -> tuple[str, str, int]:
    """Run a git command and return (stdout, stderr, exit_code)."""
    proc = None
    try:
        proc = await kaos.exec("git", "-C", cwd, *args)
        proc.stdin.close()
        stdout_bytes = await asyncio.wait_for(proc.stdout.read(-1), timeout=timeout)
        stderr_bytes = await asyncio.wait_for(proc.stderr.read(-1), timeout=timeout)
        exit_code = await asyncio.wait_for(proc.wait(), timeout=timeout)
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        return stdout, stderr, exit_code
    except TimeoutError:
        logger.debug("git {args} timed out after {t}s", args=args, t=timeout)
        if proc is not None:
            await proc.kill()
            await proc.wait()
        return "", "timeout", 1
    except Exception:
        logger.debug("git {args} failed", args=args)
        if proc is not None and proc.returncode is None:
            await proc.kill()
            await proc.wait()
        return "", "exception", 1


def _rmtree_sync(path: Path) -> None:
    """Synchronous rmtree helper for asyncio.to_thread."""
    import shutil

    shutil.rmtree(path, ignore_errors=True)
