"""Environment detection helpers."""

from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class EnvironmentContext:
    """Snapshot of host environment characteristics."""

    os_name: str
    os_version: str
    machine: str
    shell: str

    def as_prompt(self) -> str:
        """Format a succinct prompt-friendly summary."""
        details = [
            f"OS: {self.os_name} {self.os_version} ({self.machine})",
            f"Shell: {self.shell}",
        ]
        return "\n".join(f"- {line}" for line in details)


def detect_shell(os_name: str) -> str:
    if os.name == "nt" or os_name.lower().startswith("win"):
        return os.environ.get("COMSPEC", "cmd.exe")
    return os.environ.get("SHELL", "/bin/sh")


def collect_environment_context(work_dir: Path | None = None) -> EnvironmentContext:
    """Collect environment data for prompt injection and tooling."""

    try:
        os_name = platform.system() or sys.platform
    except OSError:
        os_name = sys.platform

    try:
        os_version = platform.version()
    except OSError:
        os_version = "unknown"

    machine = platform.machine() or "unknown"

    return EnvironmentContext(
        os_name=os_name,
        os_version=os_version,
        machine=machine,
        shell=detect_shell(os_name),
    )


def format_environment_context(work_dir: Path) -> tuple[EnvironmentContext, str]:
    ctx = collect_environment_context(work_dir)
    return ctx, ctx.as_prompt()
