"""Windows UTF-8 encoding fix.

On Chinese/Japanese/Korean Windows systems the console uses a legacy code page
(e.g. GBK / cp936) by default.  PyInstaller-frozen applications ignore the
``PYTHONUTF8`` and ``PYTHONIOENCODING`` environment variables because the
embedded interpreter is already initialised by the bootloader, so
``sys.stdout.encoding`` ends up as ``"gbk"`` instead of ``"utf-8"``.

Calling ``sys.stdout.reconfigure(encoding="utf-8")`` at startup is the only
reliable fix for frozen applications on Python < 3.15 (PEP 686 makes UTF-8
the default starting from 3.15).
"""

from __future__ import annotations

import contextlib
import os
import sys


def ensure_utf8() -> None:
    """Reconfigure stdio to UTF-8 on Windows and set the console code page.

    Safe to call on any platform — non-Windows is a no-op.
    """
    if sys.platform != "win32":
        return

    # 1. Reconfigure stdin / stdout / stderr to UTF-8.
    #    ``errors="replace"`` on stdout avoids crashing on unencodable chars;
    #    ``errors="backslashreplace"`` on stderr keeps diagnostics readable.
    for stream, errors in [
        (sys.stdin, "replace"),
        (sys.stdout, "replace"),
        (sys.stderr, "backslashreplace"),
    ]:
        if stream is not None and hasattr(stream, "reconfigure"):
            with contextlib.suppress(Exception):
                stream.reconfigure(encoding="utf-8", errors=errors)

    # 2. Switch the Windows console code page to UTF-8 so that raw
    #    WriteConsole / ReadConsole calls also produce correct output.
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        kernel32.SetConsoleOutputCP(65001)
        kernel32.SetConsoleCP(65001)
    except Exception:
        pass

    # 3. Propagate UTF-8 mode to child Python processes that are NOT frozen.
    os.environ.setdefault("PYTHONUTF8", "1")
