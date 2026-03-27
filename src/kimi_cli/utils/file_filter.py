from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

_IGNORED_NAMES: frozenset[str] = frozenset(
    (
        # vcs metadata
        ".DS_Store",
        ".bzr",
        ".git",
        ".hg",
        ".svn",
        # tooling caches
        ".build",
        ".cache",
        ".coverage",
        ".fleet",
        ".gradle",
        ".idea",
        ".ipynb_checkpoints",
        ".pnpm-store",
        ".pytest_cache",
        ".pub-cache",
        ".ruff_cache",
        ".swiftpm",
        ".tox",
        ".venv",
        ".vs",
        ".vscode",
        ".yarn",
        ".yarn-cache",
        # js / frontend
        ".next",
        ".nuxt",
        ".parcel-cache",
        ".svelte-kit",
        ".turbo",
        ".vercel",
        "node_modules",
        # python packaging
        "__pycache__",
        "build",
        "coverage",
        "dist",
        "htmlcov",
        "pip-wheel-metadata",
        "venv",
        # java / jvm
        ".mvn",
        "out",
        "target",
        # dotnet / native
        "bin",
        "cmake-build-debug",
        "cmake-build-release",
        "obj",
        # bazel / buck
        "bazel-bin",
        "bazel-out",
        "bazel-testlogs",
        "buck-out",
        # misc artifacts
        ".dart_tool",
        ".serverless",
        ".stack-work",
        ".terraform",
        ".terragrunt-cache",
        "DerivedData",
        "Pods",
        "deps",
        "tmp",
        "vendor",
    )
)

_IGNORED_PATTERNS: re.Pattern[str] = re.compile(
    r"|".join(
        (
            r".*_cache$",
            r".*-cache$",
            r".*\.egg-info$",
            r".*\.dist-info$",
            r".*\.py[co]$",
            r".*\.class$",
            r".*\.sw[po]$",
            r".*~$",
            r".*\.(?:tmp|bak)$",
        )
    ),
    re.IGNORECASE,
)

_GIT_LS_FILES_TIMEOUT = 5


def is_ignored(name: str) -> bool:
    """Return *True* if *name* should be excluded from file mention results."""
    if not name:
        return True
    if name in _IGNORED_NAMES:
        return True
    return bool(_IGNORED_PATTERNS.fullmatch(name))


def detect_git(root: Path) -> bool:
    """Return *True* if *root* is inside a git work tree."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=root,
            capture_output=True,
            timeout=2,
        )
        return result.returncode == 0
    except Exception:
        return False


def git_index_mtime(root: Path) -> float | None:
    """Return the mtime of ``.git/index``, or *None* if unavailable."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode != 0:
            return None
        git_dir = Path(result.stdout.strip())
        if not git_dir.is_absolute():
            git_dir = root / git_dir
        index = git_dir / "index"
        return index.stat().st_mtime
    except Exception:
        return None


def _parse_ls_files_output(stdout: str) -> list[str]:
    """Parse ``git ls-files`` output into paths with synthesised directory entries."""
    paths: list[str] = []
    seen_dirs: set[str] = set()
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("/")
        for i in range(1, len(parts)):
            dir_path = "/".join(parts[:i]) + "/"
            if dir_path not in seen_dirs:
                seen_dirs.add(dir_path)
                paths.append(dir_path)
        paths.append(line)
    return paths


def list_files_git(
    root: Path,
    scope: str | None = None,
    *,
    include_untracked: bool = True,
) -> list[str] | None:
    """List workspace paths via ``git ls-files``, or *None* on failure.

    When *scope* is given (e.g. ``"src/utils"``), only files under that
    subtree are returned.  When *include_untracked* is *True*, untracked
    files (respecting ``.gitignore``) are appended via
    ``--others --exclude-standard``.
    """
    cmd = [
        "git",
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--recurse-submodules",
    ]
    if scope:
        cmd.append(scope + "/")
    try:
        result = subprocess.run(
            cmd,
            cwd=root,
            capture_output=True,
            text=True,
            timeout=_GIT_LS_FILES_TIMEOUT,
        )
        if result.returncode != 0:
            return None
    except Exception:
        return None

    paths = _parse_ls_files_output(result.stdout)

    if include_untracked:
        others_cmd = [
            "git",
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
        ]
        if scope:
            others_cmd.append(scope + "/")
        try:
            others = subprocess.run(
                others_cmd,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=_GIT_LS_FILES_TIMEOUT,
            )
            if others.returncode == 0:
                tracked = set(paths)
                for p in _parse_ls_files_output(others.stdout):
                    if p not in tracked:
                        paths.append(p)
        except Exception:
            pass

    return paths


def list_files_walk(
    root: Path,
    scope: str | None = None,
    *,
    limit: int = 1000,
) -> list[str]:
    """List workspace paths via ``os.walk`` (fallback for non-git repos).

    When *scope* is given, the walk starts from that subdirectory.
    """
    walk_root = root / scope if scope else root

    paths: list[str] = []
    try:
        for current_root, dirs, files in os.walk(walk_root):
            relative_root = Path(current_root).relative_to(root)

            dirs[:] = sorted(d for d in dirs if not is_ignored(d))

            if relative_root.parts and any(is_ignored(part) for part in relative_root.parts):
                dirs[:] = []
                continue

            if relative_root.parts:
                paths.append(relative_root.as_posix() + "/")
                if len(paths) >= limit:
                    break

            for file_name in sorted(files):
                if is_ignored(file_name):
                    continue
                relative = (relative_root / file_name).as_posix()
                if not relative:
                    continue
                paths.append(relative)
                if len(paths) >= limit:
                    break

            if len(paths) >= limit:
                break
    except OSError:
        pass

    return paths


def list_directory_filtered(directory: Path) -> list[dict[str, str | int]]:
    """List immediate children of *directory*, filtering ignored entries.

    Returns dicts with ``name``, ``type`` (``"file"``/``"directory"``), and
    optionally ``size``.  Suitable for the web API response.
    """
    result: list[dict[str, str | int]] = []
    try:
        for subpath in directory.iterdir():
            if is_ignored(subpath.name):
                continue
            if subpath.is_dir():
                result.append({"name": subpath.name, "type": "directory"})
            else:
                try:
                    size = subpath.stat().st_size
                except OSError:
                    size = 0
                result.append({"name": subpath.name, "type": "file", "size": size})
    except OSError:
        pass
    result.sort(key=lambda x: (str(x["type"]), str(x["name"])))
    return result
