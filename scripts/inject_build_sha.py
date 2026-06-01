#!/usr/bin/env python3
"""Inject build SHA into src/kimi_cli/_build_info.py for telemetry provenance.

Called before wheel builds and PyInstaller builds to hardcode the git commit
SHA (with remote origin) into the package so telemetry can reliably distinguish
official builds from forks or dirty installs.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _resolve_project_root() -> Path:
    """Return the project root (parent of the scripts/ directory)."""
    return Path(__file__).resolve().parent.parent


def _normalize_remote(url: str) -> str:
    """Normalize a git remote URL to host/path format.

    Strips protocol, userinfo (user:pass@), and trailing ``.git``.

    Examples:
        git@github.com:user/repo.git          -> github.com/user/repo
        https://github.com/user/repo.git      -> github.com/user/repo
        https://user:token@github.com/repo.git -> github.com/repo
    """
    url = url.strip()
    # Remove protocol prefixes
    for prefix in ("git@", "https://", "http://"):
        if url.startswith(prefix):
            url = url[len(prefix) :]
    # Remove userinfo (e.g. user:pass@)
    if "@" in url:
        url = url.split("@", 1)[1]
    # Remove trailing .git
    if url.endswith(".git"):
        url = url[:-4]
    # Replace first colon (in SSH format) with slash
    if ":" in url and "/" not in url.split(":", 1)[0]:
        url = url.replace(":", "/", 1)
    return url


def _detect_remote() -> str:
    """Return the normalized origin remote URL, empty string if unavailable."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=_resolve_project_root(),
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            return _normalize_remote(result.stdout)
    except Exception:
        pass
    return ""


def _detect_sha() -> str:
    """Return the build SHA from env or git, empty string if unavailable."""
    if sha := os.environ.get("KIMI_BUILD_SHA", "").strip():
        return sha

    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=_resolve_project_root(),
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip()[:12]
    except Exception:
        pass

    return ""


def _assemble(remote: str, sha: str) -> str:
    """Assemble the final build identifier: remote@sha or just sha."""
    if remote and sha:
        return f"{remote}@{sha}"
    return sha or remote


def main() -> int:
    remote = _detect_remote()
    sha = _detect_sha()
    build_id = _assemble(remote, sha)

    target = _resolve_project_root() / "src" / "kimi_cli" / "_build_info.py"
    target.write_text(f'BUILD_SHA = "{build_id}"\n')
    print(f"Injected build_sha={build_id!r} into {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
