"""Utilities for subprocess environment handling.

This module provides utilities to handle environment variables when spawning
subprocesses from a PyInstaller-frozen application. The main issue is that
PyInstaller's bootloader modifies LD_LIBRARY_PATH to prioritize bundled libraries,
which can cause conflicts when spawning external programs that expect system libraries.

See: https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html
"""

from __future__ import annotations

import os
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
