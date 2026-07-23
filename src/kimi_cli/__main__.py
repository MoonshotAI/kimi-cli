from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path


def _ensure_utf8_stdio() -> None:
    """Use UTF-8 for the standard Windows text streams when they support it.

    Git Bash may expose the Windows legacy code page (for example, cp936) to
    Python.  The interactive UI contains characters outside those code pages,
    so Rich can otherwise fail while rendering the welcome panel.  Redirected
    and non-standard streams are deliberately left alone.
    """
    if sys.platform != "win32":
        return

    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name)
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, TypeError, ValueError):
            # Some embedders expose text-like streams with a partial or locked
            # reconfigure implementation. Preserve those streams as-is.
            continue


def _prog_name() -> str:
    return Path(sys.argv[0]).name or "kimi"


def main(argv: Sequence[str] | None = None) -> int | str | None:
    _ensure_utf8_stdio()

    from kimi_cli.telemetry.crash import install_crash_handlers, set_phase
    from kimi_cli.utils.proxy import normalize_proxy_env

    # Install excepthook before anything else so startup-phase crashes are captured.
    install_crash_handlers()
    normalize_proxy_env()

    args = list(sys.argv[1:] if argv is None else argv)

    if len(args) == 1 and args[0] in {"--version", "-V"}:
        from kimi_cli.constant import get_version

        print(f"kimi, version {get_version()}")
        return 0

    from kimi_cli.cli import cli
    from kimi_cli.utils.environment import GitBashNotFoundError

    try:
        return cli(args=args, prog_name=_prog_name())
    except SystemExit as exc:
        return exc.code
    except GitBashNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        set_phase("shutdown")


if __name__ == "__main__":
    raise SystemExit(main())
