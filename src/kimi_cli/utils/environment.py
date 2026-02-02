from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from typing import Literal

from kaos.path import KaosPath

from kimi_cli.config import ShellConfig
from kimi_cli.utils.logging import logger


@dataclass(slots=True, frozen=True, kw_only=True)
class Environment:
    os_kind: Literal["Windows", "Linux", "macOS"] | str
    os_arch: str
    os_version: str
    shell_name: Literal["bash", "sh", "Windows PowerShell", "zsh"]
    shell_path: KaosPath

    @staticmethod
    async def detect(shell_config: ShellConfig | None = None) -> Environment:
        """Detect environment with optional shell configuration."""
        # Detect OS
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

        # Determine shell based on OS
        if os_kind == "Windows":
            shell_name, shell_path = await Environment._determine_windows_shell(shell_config)
        else:
            shell_name, shell_path = await Environment._determine_unix_shell(shell_config)

        return Environment(
            os_kind=os_kind,
            os_arch=os_arch,
            os_version=os_version,
            shell_name=shell_name,  # type: ignore[reportReturnType]
            shell_path=shell_path,
        )

    @staticmethod
    async def _determine_windows_shell(
        shell_config: ShellConfig | None = None,
    ) -> tuple[str, KaosPath]:
        """Determine shell on Windows with priority: config > env var > auto-detect > fallback."""
        config = shell_config or ShellConfig()

        # Priority 1: Explicit path in config
        if config.path:
            path = KaosPath(config.path.replace("\\", "/"))
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path
            logger.warning(
                "Configured shell path not found: {path}, will use fallback shell detection",
                path=config.path,
            )

        # Priority 2: SHELL environment variable (only when preferred="auto")
        # This respects the user's terminal setup without requiring config changes
        if config.preferred == "auto" and (env_shell := os.environ.get("SHELL")):
            path = KaosPath(env_shell.replace("\\", "/"))
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path

        # Priority 3: Auto-detect bash if preferred is "auto" or "bash"
        if config.preferred in ("auto", "bash"):
            bash_paths = [
                # Git Bash - standard locations
                KaosPath("C:/Program Files/Git/bin/bash.exe"),
                KaosPath("C:/Program Files (x86)/Git/bin/bash.exe"),
                KaosPath(os.path.expanduser("~/AppData/Local/Programs/Git/bin/bash.exe")),
                # MSYS2
                KaosPath("C:/msys64/usr/bin/bash.exe"),
                KaosPath("C:/msys32/usr/bin/bash.exe"),
                # Cygwin
                KaosPath("C:/cygwin64/bin/bash.exe"),
                KaosPath("C:/cygwin/bin/bash.exe"),
                # WSL
                KaosPath("C:/Windows/System32/bash.exe"),
            ]

            for path in bash_paths:
                if await path.is_file():
                    return "bash", path

        # Priority 4: Fallback to PowerShell (backwards compatible default)
        return "Windows PowerShell", KaosPath("powershell.exe")

    @staticmethod
    async def _determine_unix_shell(
        shell_config: ShellConfig | None = None,
    ) -> tuple[str, KaosPath]:
        """Determine shell on Unix-like systems.

        Note: config.preferred is intentionally not used on Unix. The standard
        Unix convention is to respect SHELL env var and auto-detect from well-known
        paths. Use config.path for explicit control.
        """
        config = shell_config or ShellConfig()

        # Priority 1: Explicit path in config
        if config.path:
            path = KaosPath(config.path)
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path
            logger.warning(
                "Configured shell path not found: {path}, will use fallback shell detection",
                path=config.path,
            )

        # Priority 2: SHELL environment variable
        if env_shell := os.environ.get("SHELL"):
            path = KaosPath(env_shell)
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path

        # Priority 3: Auto-detect common shells
        possible_paths = [
            KaosPath("/bin/bash"),
            KaosPath("/usr/bin/bash"),
            KaosPath("/usr/local/bin/bash"),
        ]
        fallback_path = KaosPath("/bin/sh")

        for path in possible_paths:
            if await path.is_file():
                return "bash", path

        return "sh", fallback_path

    @staticmethod
    def _infer_shell_name(
        path: str,
    ) -> Literal["bash", "sh", "Windows PowerShell", "zsh"]:
        """Infer shell name from executable path."""
        path_lower = path.lower()
        if "powershell" in path_lower or "pwsh" in path_lower:
            return "Windows PowerShell"
        elif "bash" in path_lower:
            return "bash"
        elif "zsh" in path_lower:
            return "zsh"
        else:
            return "sh"
