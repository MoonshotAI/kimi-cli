"""Collect git repository context for explore subagents."""

from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

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
            body = "\n".join(f"  {line[:200]}" for line in log_lines)
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


# Well-known public hosts whose remote URLs are safe to surface and
# recognizable enough for the model to infer project ecosystem context.
_ALLOWED_HOSTS = (
    "github.com",
    "gitlab.com",
    "gitee.com",
    "bitbucket.org",
    "codeberg.org",
    "sr.ht",
)


def _sanitize_remote_url(remote_url: str) -> str | None:
    """Return the remote URL if it points to a well-known public host.

    Credentials are stripped from HTTPS URLs.

    Recognizable remote URLs help orient the agent within the broader project
    ecosystem (e.g. issue tracker conventions, CI patterns).  Self-hosted or
    unrecognized hosts are excluded to avoid leaking internal infrastructure.
    """
    # SSH format: git@host:owner/repo.git — no credentials possible
    for host in _ALLOWED_HOSTS:
        if re.match(rf"^git@{re.escape(host)}:", remote_url):
            return remote_url

    # HTTPS format: parse hostname exactly, strip userinfo
    try:
        parsed = urlparse(remote_url)
        _ = parsed.port  # raises ValueError on malformed port like :443.evil
    except ValueError:
        return None
    if parsed.hostname in _ALLOWED_HOSTS:
        # Rebuild without userinfo: https://host[:port]/path
        port_part = f":{parsed.port}" if parsed.port else ""
        return f"https://{parsed.hostname}{port_part}{parsed.path}"

    return None


def _parse_project_name(remote_url: str) -> str | None:
    """Extract ``owner/repo`` from a git remote URL.

    Supports typical SSH (e.g. ``git@github.com:owner/repo.git``,
    ``git@gitlab.com:owner/repo.git``) and HTTPS (e.g.
    ``https://github.com/owner/repo.git``,
    ``https://gitee.com/owner/repo.git``) formats by taking the
    trailing ``owner/repo`` component regardless of host.
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
