from __future__ import annotations

import os
import subprocess
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, cast

NAME = "Kimi Code CLI"

if TYPE_CHECKING:
    VERSION: str
    USER_AGENT: str

# Build SHA injected at package/build time via scripts/inject_build_sha.py.
# When present it overrides any runtime detection.


@cache
def get_version() -> str:
    from importlib import metadata

    return metadata.version("kimi-cli")


@cache
def get_user_agent() -> str:
    return f"KimiCLI/{get_version()}"


def _normalize_remote(url: str) -> str:
    """Normalize a git remote URL to host/path format."""
    url = url.strip()
    for prefix in ("git@", "https://", "http://"):
        if url.startswith(prefix):
            url = url[len(prefix) :]
    if "@" in url:
        url = url.split("@", 1)[1]
    if url.endswith(".git"):
        url = url[:-4]
    if ":" in url and "/" not in url.split(":", 1)[0]:
        url = url.replace(":", "/", 1)
    return url


@cache
def get_build_sha() -> str:
    """Return the build identifier of this build.

    Format: ``remote@sha`` when remote is available, otherwise just ``sha``.

    Priority:
    1. KIMI_BUILD_SHA environment variable (dev / CI override)
    2. Hardcoded BUILD_SHA from _build_info.py (set by wheel / PyInstaller build)
    3. git remote + git rev-parse HEAD from the package directory (dev mode)
    4. Empty string (fallback)
    """
    if build_id := os.environ.get("KIMI_BUILD_SHA", "").strip():
        return build_id

    try:
        from kimi_cli._build_info import BUILD_SHA  # type: ignore[reportMissingImports]

        return cast(str, BUILD_SHA)
    except ImportError:
        pass

    sha = ""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            sha = result.stdout.strip()[:12]
    except Exception:
        pass

    remote = ""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            remote = _normalize_remote(result.stdout)
    except Exception:
        pass

    if remote and sha:
        return f"{remote}@{sha}"
    return sha


def __getattr__(name: str) -> str:
    if name == "VERSION":
        return get_version()
    if name == "USER_AGENT":
        return get_user_agent()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "NAME",
    "VERSION",
    "USER_AGENT",
    "get_version",
    "get_user_agent",
    "get_build_sha",
]
