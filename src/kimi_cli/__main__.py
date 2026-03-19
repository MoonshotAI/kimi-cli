from __future__ import annotations

import io
import os
import sys
from collections.abc import Sequence
from pathlib import Path


def _ensure_utf8_stdio() -> None:
    """Reconfigure stdout/stderr to UTF-8 on Windows to prevent ASCII encoding crashes.

    On Windows with certain locales, Python defaults to a legacy ANSI code page
    (e.g. cp1252 or even ascii), which causes UnicodeEncodeError when printing
    emoji or CJK characters used in prompt symbols and model output.
    """
    if sys.platform != "win32":
        return
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name)
        if stream is None or getattr(stream, "encoding", "").lower().replace("-", "") == "utf8":
            continue
        if isinstance(stream, io.TextIOWrapper):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass
        else:
            try:
                binary = getattr(stream, "buffer", None)
                if binary is not None:
                    wrapper = io.TextIOWrapper(binary, encoding="utf-8", errors="replace", line_buffering=stream.line_buffering)
                    setattr(sys, stream_name, wrapper)
            except Exception:
                pass
    # Also hint to child processes
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def _prog_name() -> str:
    return Path(sys.argv[0]).name or "kimi"


def main(argv: Sequence[str] | None = None) -> int | str | None:
    _ensure_utf8_stdio()
    args = list(sys.argv[1:] if argv is None else argv)

    if len(args) == 1 and args[0] in {"--version", "-V"}:
        from kimi_cli.constant import get_version

        print(f"kimi, version {get_version()}")
        return 0

    from kimi_cli.cli import cli

    try:
        return cli(args=args, prog_name=_prog_name())
    except SystemExit as exc:
        return exc.code


if __name__ == "__main__":
    raise SystemExit(main())
