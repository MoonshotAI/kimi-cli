from __future__ import annotations

import asyncio
import platform
import shutil
from dataclasses import dataclass
from typing import Literal

from kaos.path import KaosPath


@dataclass(slots=True, frozen=True, kw_only=True)
class Environment:
    os_kind: Literal["Windows", "Linux", "macOS"] | str
    os_arch: str
    os_version: str
    shell_name: Literal["bash", "sh", "Windows PowerShell", "PowerShell"]
    shell_path: KaosPath
    shell_version: str = "unknown"  # Format: "5.1", "7.4", etc.

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
            shell_name, shell_path, shell_version = await _detect_windows_shell()
        else:
            shell_name, shell_path, shell_version = await _detect_unix_shell()

        return Environment(
            os_kind=os_kind,
            os_arch=os_arch,
            os_version=os_version,
            shell_name=shell_name,
            shell_path=shell_path,
            shell_version=shell_version,
        )


async def _detect_windows_shell() -> tuple[str, KaosPath, str]:
    """
    Detect Windows PowerShell (5.1) vs PowerShell (7+).
    
    Priority:
    1. Check for pwsh.exe (PowerShell 7+) - preferred if available
    2. Fall back to powershell.exe (Windows PowerShell 5.1)
    """
    # Fast path: check if pwsh (PS 7+) is available via PATH lookup
    pwsh_path = shutil.which("pwsh")
    
    if pwsh_path:
        shell_path = KaosPath(pwsh_path)
        shell_name = "PowerShell"
        shell_version = await _get_powershell_version(str(shell_path))
    else:
        shell_path = KaosPath("powershell.exe")
        shell_name = "Windows PowerShell"
        # Try to detect actual version, fall back to 5.1 if detection fails
        shell_version = await _get_powershell_version("powershell.exe")
        if shell_version == "unknown":
            shell_version = "5.1"
    
    return shell_name, shell_path, shell_version


async def _detect_unix_shell() -> tuple[str, KaosPath, str]:
    """Detect available shell on Unix/Linux."""
    possible_paths = [
        KaosPath("/bin/bash"),
        KaosPath("/usr/bin/bash"),
        KaosPath("/usr/local/bin/bash"),
    ]
    fallback_path = KaosPath("/bin/sh")
    
    for path in possible_paths:
        if await path.is_file():
            version = await _get_bash_version(str(path))
            return "bash", path, version
    
    return "sh", fallback_path, "unknown"


async def _get_powershell_version(ps_path: str) -> str:
    """
    Execute a single command to detect PowerShell version.
    Returns major.minor format (e.g., "5.1", "7.4").
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            ps_path,
            "-Command", "$PSVersionTable.PSVersion.ToString()",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
        version_str = stdout.decode().strip()
        
        # Parse version string like "5.1.22621.4391" to "5.1"
        parts = version_str.split(".")
        if len(parts) >= 2:
            return f"{parts[0]}.{parts[1]}"
        return version_str
    except Exception:
        return "unknown"


async def _get_bash_version(bash_path: str) -> str:
    """Get Bash version string."""
    try:
        proc = await asyncio.create_subprocess_exec(
            bash_path,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
        first_line = stdout.decode().split("\n")[0]  # "GNU bash, version 5.1.16..."
        if "version" in first_line:
            version_str = first_line.split("version")[1].strip().split()[0]
            # Return major.minor
            parts = version_str.split(".")
            if len(parts) >= 2:
                return f"{parts[0]}.{parts[1]}"
        return "unknown"
    except Exception:
        return "unknown"
