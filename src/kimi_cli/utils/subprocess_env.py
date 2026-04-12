"""Utilities for subprocess environment handling.

This module provides utilities to handle environment variables when spawning
subprocesses from a PyInstaller-frozen application. The main issue is that
PyInstaller's bootloader modifies LD_LIBRARY_PATH to prioritize bundled libraries,
which can cause conflicts when spawning external programs that expect system libraries.

See: https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html
"""

from __future__ import annotations

import os
import shutil
import sys

# Environment variables that PyInstaller may modify on Linux
_PYINSTALLER_LD_VARS = [
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
]


def get_clean_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    """
    Get a clean environment suitable for spawning subprocesses.

    In a PyInstaller-frozen application on Linux, this function restores
    the original library path environment variables, preventing subprocesses
    from loading incompatible bundled libraries.

    Args:
        base_env: Base environment to start from. If None, uses os.environ.

    Returns:
        A dictionary of environment variables safe for subprocess use.
    """
    env = dict(base_env if base_env is not None else os.environ)

    # Only process in PyInstaller frozen environment on Linux
    if not getattr(sys, "frozen", False) or sys.platform != "linux":
        return env

    for var in _PYINSTALLER_LD_VARS:
        orig_key = f"{var}_ORIG"
        if orig_key in env:
            # Restore the original value that was saved by PyInstaller bootloader
            env[var] = env[orig_key]
        elif var in env:
            # Variable was not set before PyInstaller modified it, so remove it
            del env[var]

    return env


def get_noninteractive_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    """
    Get an environment for subprocesses that must not block on interactive prompts.

    Builds on :func:`get_clean_env` and additionally configures git to fail
    fast instead of waiting for user input that will never arrive.

    Args:
        base_env: Base environment to start from. If None, uses os.environ.

    Returns:
        A dictionary of environment variables safe for non-interactive subprocess use.
    """
    env = get_clean_env(base_env)

    # GIT_TERMINAL_PROMPT=0 makes git fail instead of prompting for credentials.
    env.setdefault("GIT_TERMINAL_PROMPT", "0")

    return env


def _is_windows_app_alias(path: str) -> bool:
    """Check if *path* is a Windows App Execution Alias (0-byte stub).

    These stubs live in ``%LOCALAPPDATA%\\Microsoft\\WindowsApps`` and fail
    with ``WinError 5 (Access Denied)`` when spawned with
    ``CREATE_NO_WINDOW``, which the MCP SDK uses for stdio servers.
    """
    try:
        return os.path.getsize(path) == 0
    except OSError:
        return False


def _which_skip_aliases(command: str, env: dict[str, str] | None = None) -> str | None:
    """Like ``shutil.which`` but skips 0-byte App Execution Aliases."""
    _env = env if env is not None else os.environ
    path_dirs = _env.get("PATH", "").split(os.pathsep)
    pathext = _env.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(os.pathsep)

    for d in path_dirs:
        candidates = [command] + [command + ext for ext in pathext]
        for name in candidates:
            full = os.path.join(d, name)
            if os.path.isfile(full) and not _is_windows_app_alias(full):
                return full
    return None


# Well-known alternative names for commands that Windows Store App Aliases
# commonly shadow.  Only tried when the primary name resolves to an alias.
_WINDOWS_COMMAND_ALTERNATIVES: dict[str, list[str]] = {
    "python": ["python3"],
    "python3": ["python"],
}


def resolve_windows_executable(command: str, env: dict[str, str] | None = None) -> str:
    """Resolve *command* to a real executable, skipping Windows App Aliases.

    On non-Windows platforms this is a no-op.  On Windows it walks ``PATH``
    manually, filtering out 0-byte App Execution Alias stubs that cause
    ``WinError 5`` when launched with ``CREATE_NO_WINDOW``.

    If *env* is provided its ``PATH`` is searched instead of ``os.environ``.
    This is important for stdio MCP servers that declare a custom ``env``
    block (e.g. pointing at a venv).

    If the primary command only resolves to an alias, well-known alternatives
    are tried (e.g. ``python3`` when ``python`` is an alias).
    """
    if sys.platform != "win32":
        return command

    # Already a full path — just validate it
    if os.sep in command or "/" in command:
        if os.path.isfile(command) and not _is_windows_app_alias(command):
            return command
        return command  # Nothing better to do

    # Walk PATH, skipping App Aliases
    found = _which_skip_aliases(command, env)
    if found:
        return found

    # Try well-known alternatives (e.g. python -> python3)
    for alt in _WINDOWS_COMMAND_ALTERNATIVES.get(command, []):
        found = _which_skip_aliases(alt, env)
        if found:
            return found

    # Fallback: return whatever shutil.which finds (may be an alias)
    return shutil.which(command) or command
