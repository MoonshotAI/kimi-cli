from __future__ import annotations

import platform
import shutil
from dataclasses import dataclass
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

from kaos.path import KaosPath

# Known shells and their friendly names
_SHELL_NAMES: dict[str, str] = {
    "powershell.exe": "Windows PowerShell",
    "powershell": "Windows PowerShell",
    "pwsh.exe": "PowerShell",
    "pwsh": "PowerShell",
    "cmd.exe": "cmd",
    "cmd": "cmd",
    "bash": "bash",
    "bash.exe": "bash",
    "sh": "sh",
    "zsh": "zsh",
    "fish": "fish",
}


def _resolve_shell(shell_path_str: str) -> tuple[str, KaosPath]:
    """Resolve a user-provided shell path to (shell_name, shell_path)."""
    # Try to find the shell on PATH if not an absolute path
    resolved = shutil.which(shell_path_str)
    if resolved:
        shell_path = KaosPath(resolved)
    else:
        shell_path = KaosPath(shell_path_str)

    # Derive the friendly name from the binary name
    try:
        stem = PureWindowsPath(shell_path_str).stem
    except Exception:
        stem = PurePosixPath(shell_path_str).stem
    basename = PureWindowsPath(shell_path_str).name if "\\" in shell_path_str else PurePosixPath(shell_path_str).name
    shell_name = _SHELL_NAMES.get(basename, _SHELL_NAMES.get(stem, stem))
    return shell_name, shell_path


@dataclass(slots=True, frozen=True, kw_only=True)
class Environment:
    os_kind: Literal["Windows", "Linux", "macOS"] | str
    os_arch: str
    os_version: str
    shell_name: str
    shell_path: KaosPath

    @staticmethod
    async def detect(*, default_shell: str = "") -> Environment:
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

        if default_shell:
            shell_name, shell_path = _resolve_shell(default_shell)
        elif os_kind == "Windows":
            shell_name = "Windows PowerShell"
            shell_path = KaosPath("powershell.exe")
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
