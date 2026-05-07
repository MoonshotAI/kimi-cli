"""Pure-Python conversions between Windows-native and POSIX (MSYS/git-bash) paths.

These helpers exist for the same reason claude-code's `windowsPaths.ts` does:
on Windows, kimi-cli runs the Shell tool through Git for Windows' bash, which
needs POSIX paths like `/c/Users/foo`, while Python's `os`/`pathlib` APIs need
native paths like `C:\\Users\\foo`. The two forms cross constantly between the
agent (which may emit either), the shell command string, and the Python file
operations that read/write the result.

Implemented as plain regex (no `cygpath` shell-out) for predictability and to
avoid runtime dependency on git-bash being present at conversion time.
"""

from __future__ import annotations

from functools import lru_cache


@lru_cache(maxsize=512)
def windows_path_to_posix(path: str) -> str:
    """Convert a Windows-native path to a POSIX (MSYS/git-bash) path.

    Examples:
        ``C:\\Users\\foo`` -> ``/c/Users/foo`` (drive letter lowercased)
        ``\\\\server\\share`` -> ``//server/share``
        ``relative\\path`` -> ``relative/path``
    """
    # UNC: \\server\share -> //server/share
    if path.startswith("\\\\"):
        return path.replace("\\", "/")

    # Drive letter: C:\... or C:/... -> /c/...
    if len(path) >= 3 and path[1] == ":" and path[2] in ("\\", "/"):
        drive = path[0].lower()
        rest = path[2:].replace("\\", "/")
        return "/" + drive + rest

    # Already POSIX or relative — flip slashes
    return path.replace("\\", "/")


@lru_cache(maxsize=512)
def posix_path_to_windows(path: str) -> str:
    """Convert a POSIX (MSYS/git-bash/Cygwin) path to a Windows-native path.

    Examples:
        ``/c/Users/foo`` -> ``C:\\Users\\foo`` (drive letter uppercased)
        ``/cygdrive/c/Users/foo`` -> ``C:\\Users\\foo``
        ``//server/share`` -> ``\\\\server\\share``
        ``relative/path`` -> ``relative\\path``
    """
    # UNC: //server/share -> \\server\share
    if path.startswith("//"):
        return path.replace("/", "\\")

    # Cygwin drive: /cygdrive/c/... -> C:\...
    if path.startswith("/cygdrive/") and len(path) >= 11 and path[11:12] in ("/", ""):
        drive = path[10].upper()
        rest = path[11:].replace("/", "\\") or "\\"
        return drive + ":" + rest

    # MSYS/git-bash drive: /c/... or /c -> C:\... or C:\
    if (
        len(path) >= 2
        and path[0] == "/"
        and path[1].isalpha()
        and (len(path) == 2 or path[2] == "/")
    ):
        drive = path[1].upper()
        rest = path[2:].replace("/", "\\") or "\\"
        return drive + ":" + rest

    # Already Windows or relative — flip slashes
    return path.replace("/", "\\")
