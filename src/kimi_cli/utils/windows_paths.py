"""POSIX→Windows path conversion for user-supplied paths.

On Windows, kimi-cli runs the Shell tool through Git for Windows' bash. The
model may pass POSIX-form paths (``/c/Users/foo``) to the file tools, but
Python's ``os``/``pathlib`` APIs need native form (``C:\\Users\\foo``). This
helper does the conversion at the file-tool entry boundary
(:func:`kimi_cli.utils.path.normalize_user_path`).

Implemented with prefix checks and string replacement (no ``cygpath`` shell-out)
for predictability and to avoid a runtime dependency on git-bash being present
at conversion time.
"""

from __future__ import annotations


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
