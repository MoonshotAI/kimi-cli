"""Collect git repository context for explore subagents."""

from __future__ import annotations

import asyncio
import re

import kaos
from kaos.path import KaosPath

from kimi_cli.utils.logging import logger

_TIMEOUT = 5.0
_MAX_DIRTY_FILES = 20


async def collect_git_context(work_dir: KaosPath) -> str:
    """Collect git context information for the explore agent.

    Returns a formatted ``<git-context>`` block, or an empty string if the
    directory is not a git repository or all git commands fail.  Every git
    command is individually guarded so a single failure never breaks the whole
    collection.
    """
    cwd = str(work_dir)

    # Quick check: is this a git repo?
    if await _run_git(["rev-parse", "--is-inside-work-tree"], cwd) is None:
        return ""

    # Run all git commands in parallel for speed
    remote_url, branch, dirty_raw, log_raw = await asyncio.gather(
        _run_git(["remote", "get-url", "origin"], cwd),
        _run_git(["branch", "--show-current"], cwd),
        _run_git(["status", "--porcelain"], cwd),
        _run_git(["log", "-3", "--format=%h %s"], cwd),
    )

    sections: list[str] = []
    sections.append(f"Working directory: {cwd}")

    # Remote origin & project name
    if remote_url:
        safe_url = _sanitize_remote_url(remote_url)
        if safe_url:
            sections.append(f"Remote: {safe_url}")
        project = _parse_project_name(remote_url)
        if project:
            sections.append(f"Project: {project}")

    # Current branch
    if branch:
        sections.append(f"Branch: {branch}")

    # Dirty files
    if dirty_raw is not None:
        dirty_lines = [line for line in dirty_raw.splitlines() if line.strip()]
        if dirty_lines:
            total = len(dirty_lines)
            shown = dirty_lines[:_MAX_DIRTY_FILES]
            header = f"Dirty files ({total}):"
            body = "\n".join(f"  {line}" for line in shown)
            if total > _MAX_DIRTY_FILES:
                body += f"\n  ... and {total - _MAX_DIRTY_FILES} more"
            sections.append(f"{header}\n{body}")

    # Recent commits
    if log_raw:
        log_lines = [line for line in log_raw.splitlines() if line.strip()]
        if log_lines:
            body = "\n".join(f"  {line}" for line in log_lines)
            sections.append(f"Recent commits:\n{body}")

    if len(sections) <= 1:
        # Only the working directory line — nothing useful collected
        return ""

    content = "\n".join(sections)
    return f"<git-context>\n{content}\n</git-context>"


async def _run_git(args: list[str], cwd: str, timeout: float = _TIMEOUT) -> str | None:
    """Run a single git command via kaos.exec and return stripped stdout, or None on failure.

    Uses ``git -C <cwd>`` so the command runs in the specified directory
    regardless of the kaos backend's current working directory.  Works
    transparently on both local and remote (SSH) backends.
    """
    proc = None
    try:
        proc = await kaos.exec("git", "-C", cwd, *args)
        proc.stdin.close()
        stdout_bytes = await asyncio.wait_for(proc.stdout.read(-1), timeout=timeout)
        exit_code = await asyncio.wait_for(proc.wait(), timeout=timeout)
        if exit_code != 0:
            return None
        return stdout_bytes.decode("utf-8", errors="replace").strip()
    except TimeoutError:
        logger.debug("git {args} timed out after {t}s", args=args, t=timeout)
        if proc is not None:
            await proc.kill()
            await proc.wait()
        return None
    except Exception:
        logger.debug("git {args} failed", args=args)
        if proc is not None and proc.returncode is None:
            await proc.kill()
            await proc.wait()
        return None


def _sanitize_remote_url(remote_url: str) -> str | None:
    """Return the remote URL only if it points to github.com, with credentials stripped.

    Returns ``None`` for non-GitHub remotes or URLs that cannot be sanitized.
    """
    # SSH format: git@github.com:owner/repo.git — no credentials possible
    if re.match(r"^git@github\.com:", remote_url):
        return remote_url

    # HTTPS format: strip userinfo and only allow github.com
    m = re.match(r"^https?://(?:[^@]+@)?(github\.com/.+)$", remote_url)
    if m:
        return f"https://{m.group(1)}"

    return None


def _parse_project_name(remote_url: str) -> str | None:
    """Extract ``owner/repo`` from a git remote URL.

    Supports both SSH (``git@github.com:owner/repo.git``) and HTTPS
    (``https://github.com/owner/repo.git``) formats.
    """
    # SSH format: git@host:owner/repo.git
    m = re.search(r":([^/]+/[^/]+?)(?:\.git)?$", remote_url)
    if m:
        return m.group(1)
    # HTTPS format: https://host/owner/repo.git
    m = re.search(r"/([^/]+/[^/]+?)(?:\.git)?$", remote_url)
    if m:
        return m.group(1)
    return None
