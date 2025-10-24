from __future__ import annotations

import subprocess
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Final

_PROMPT_CACHE: str | None = None
MAX_CHANGES_CHARS: Final[int] = 8_000
# Git's standard hash for an empty tree - used to diff against when repository has no commits yet
# This is a well-known constant in Git internals, see: git hash-object -t tree /dev/null
_EMPTY_TREE_SHA: Final[str] = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
_PROMPT_FILENAME: Final[str] = "review.md"


class ReviewError(RuntimeError):
    """Raised when a review helper operation fails."""


@dataclass
class CommitInfo:
    sha: str
    short_sha: str
    subject: str
    timestamp: int


def is_git_repo(path: Path) -> bool:
    """Check if the given path is a git repository.

    Returns False instead of raising exceptions for consistency with callers
    that use this as a boolean check.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def get_recent_commits(path: Path, *, limit: int = 20) -> list[CommitInfo]:
    if not is_git_repo(path):
        return []

    format_str = "%H%x1f%ct%x1f%s"
    try:
        result = subprocess.run(
            ["git", "log", "-n", str(limit), f"--pretty=format:{format_str}"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.SubprocessError, subprocess.TimeoutExpired):
        return []

    if result.returncode != 0:
        return []

    commits: list[CommitInfo] = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        sha, ts, subject = (part.strip() for part in line.split("\u001f", 2))
        if not sha:
            continue
        try:
            timestamp = int(ts)
        except ValueError:
            timestamp = 0
        commits.append(CommitInfo(sha=sha, short_sha=sha[:7], subject=subject, timestamp=timestamp))

    return commits


def collect_uncommitted_diff(path: Path) -> str:
    if not is_git_repo(path):
        raise ReviewError("Current directory is not a git repository")

    status = _run_git(["status", "--short"], path)

    if _has_head(path):
        diff = _run_git(["diff", "HEAD"], path)
        diff_header = "# git diff HEAD"
    else:
        diff = _run_git(["diff", _EMPTY_TREE_SHA], path)
        diff_header = "# git diff <empty tree>"

    if not diff.strip():
        raise ReviewError("No uncommitted changes detected")

    combined = ["# git status --short", status.strip(), f"\n{diff_header}", diff.rstrip()]
    return "\n".join(part for part in combined if part)


def collect_commit_diff(path: Path, commit_sha: str) -> str:
    if not is_git_repo(path):
        raise ReviewError("Current directory is not a git repository")

    commit_sha = commit_sha.strip()
    if not commit_sha:
        raise ReviewError("Commit SHA cannot be empty")

    try:
        show_output = _run_git(["show", commit_sha], path)
    except ReviewError as exc:  # propagate with clearer message
        raise ReviewError(f"Unable to read diff for commit {commit_sha}: {exc}") from exc

    return show_output.rstrip()


def build_review_prompt(changes: str, *, scope_hint: str | None = None) -> str:
    template = _load_prompt_template()

    scoped_changes = changes.strip()
    truncated, truncated_flag = _truncate(scoped_changes)
    if truncated_flag:
        truncated += "\n\n[Note] Diff content truncated due to length limits."

    sections = [template.rstrip(), "", "## Review Scope"]
    if scope_hint:
        sections.append(scope_hint.strip())
    else:
        sections.append("No explicit scope provided; reviewing all supplied changes.")
    sections.extend(
        [
            "",
            "## Code Diff",
            "```diff",
            truncated,
            "```",
        ]
    )

    return "\n".join(sections)


def _truncate(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_CHANGES_CHARS:
        return text, False
    return text[:MAX_CHANGES_CHARS], True


def _load_prompt_template() -> str:
    global _PROMPT_CACHE
    if _PROMPT_CACHE is not None:
        return _PROMPT_CACHE

    errors: list[str] = []

    try:
        with resources.as_file(
            resources.files(__package__).joinpath(_PROMPT_FILENAME)
        ) as prompt_path:
            template = prompt_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as exc:
        errors.append(f"package resource {_PROMPT_FILENAME}: {exc}")
        fallback_path = Path(__file__).resolve().with_name(_PROMPT_FILENAME)
        try:
            template = fallback_path.read_text(encoding="utf-8")
        except OSError as fallback_exc:
            errors.append(f"{fallback_path}: {fallback_exc}")
            raise ReviewError(
                "Unable to read review prompt template: " + "; ".join(errors)
            ) from fallback_exc
    _PROMPT_CACHE = template
    return template


def _run_git(args: list[str], path: Path) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.SubprocessError, subprocess.TimeoutExpired) as exc:
        raise ReviewError(f"Failed to run git {' '.join(args)}: {exc}") from exc

    if result.returncode != 0:
        raise ReviewError(result.stderr.strip() or f"git {' '.join(args)} exited with errors")

    return result.stdout


def _has_head(path: Path) -> bool:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, subprocess.TimeoutExpired):
        return False

    return result.returncode == 0
