from __future__ import annotations

import asyncio
import ntpath
import os
import platform
import shutil
from dataclasses import dataclass
from typing import Literal

from kaos.path import KaosPath


class GitBashNotFoundError(RuntimeError):
    """Raised when kimi-cli runs on Windows but cannot locate git-bash.

    git-bash (from Git for Windows) is required because kimi-cli's Shell tool
    runs commands through bash, not PowerShell.
    """


_GIT_BASH_INSTALL_HINT = (
    "kimi-cli on Windows requires Git for Windows (https://git-scm.com/downloads/win) "
    "for its bundled bash. If git-bash is installed but not on PATH, set the "
    "KIMI_CLI_GIT_BASH_PATH environment variable to your bash.exe, e.g.:\n"
    "    KIMI_CLI_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe"
)


@dataclass(slots=True, frozen=True, kw_only=True)
class Environment:
    os_kind: Literal["Windows", "Linux", "macOS"] | str
    os_arch: str
    os_version: str
    shell_name: Literal["bash", "sh"]
    shell_path: KaosPath

    @staticmethod
    async def detect() -> Environment:
        match platform.system():
            case "Darwin":
                os_kind = "macOS"
            case "Windows":
                os_kind = "Windows"
            case "Linux":
                os_kind = "Linux"
            case system:
                os_kind = system

        os_arch = platform.machine()
        os_version = platform.version()

        if os_kind == "Windows":
            shell_path = await _find_git_bash_path()
            shell_name: Literal["bash", "sh"] = "bash"
        else:
            possible_paths = [
                KaosPath("/bin/bash"),
                KaosPath("/usr/bin/bash"),
                KaosPath("/usr/local/bin/bash"),
            ]
            fallback_path = KaosPath("/bin/sh")
            for path in possible_paths:
                if await path.is_file():
                    shell_name = "bash"
                    shell_path = path
                    break
            else:
                shell_name = "sh"
                shell_path = fallback_path

        return Environment(
            os_kind=os_kind,
            os_arch=os_arch,
            os_version=os_version,
            shell_name=shell_name,
            shell_path=shell_path,
        )


def is_windows() -> bool:
    """Return True iff the current process is running on native Windows."""
    return platform.system() == "Windows"


async def _find_git_bash_path() -> KaosPath:
    """Locate ``bash.exe`` from Git for Windows.

    Resolution order:
      1. ``KIMI_CLI_GIT_BASH_PATH`` environment variable (validated to exist).
      2. ``where.exe git`` -> ``<gitDir>/../bin/bash.exe``.
      3. Common install locations (``C:\\Program Files\\Git\\bin\\bash.exe``).

    Raises:
        GitBashNotFoundError: if no candidate path resolves to an existing file.
    """
    override = os.environ.get("KIMI_CLI_GIT_BASH_PATH")
    if override:
        candidate = KaosPath(override)
        if await candidate.is_file():
            return candidate
        raise GitBashNotFoundError(
            f"KIMI_CLI_GIT_BASH_PATH points to {override} but no file exists there.\n\n"
            + _GIT_BASH_INSTALL_HINT
        )

    git_path = await _find_git_executable()
    if git_path is not None:
        # git.exe usually lives at <git>/cmd/git.exe; bash.exe is at <git>/bin/bash.exe.
        # Use ntpath explicitly so this works regardless of the host OS that imports
        # this module (tests on macOS pass Windows-style paths through this code).
        bash_candidate = KaosPath(ntpath.join(ntpath.dirname(git_path), "..", "bin", "bash.exe"))
        if await bash_candidate.is_file():
            return bash_candidate

    fallback_candidates = [
        KaosPath(r"C:\Program Files\Git\bin\bash.exe"),
        KaosPath(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ]
    for candidate in fallback_candidates:
        if await candidate.is_file():
            return candidate

    raise GitBashNotFoundError(_GIT_BASH_INSTALL_HINT)


async def _find_git_executable() -> str | None:
    """Find git.exe on Windows via ``where.exe``. Returns absolute path or None."""
    # Defer to where.exe in a thread to keep this async-friendly.
    git_path = await asyncio.to_thread(shutil.which, "git")
    return git_path
