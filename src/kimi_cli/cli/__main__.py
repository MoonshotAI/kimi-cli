from __future__ import annotations

import sys

from kimi_cli.cli import cli

if __name__ == "__main__":
    from kimi_cli.telemetry.crash import install_crash_handlers, set_phase
    from kimi_cli.utils.proxy import normalize_proxy_env

    # Same entry treatment as kimi_cli.__main__: install excepthook before
    # anything else so startup-phase crashes in subcommand subprocesses
    # (background-task-worker, __web-worker, acp via toad) are captured.
    install_crash_handlers()
    normalize_proxy_env()
    try:
        sys.exit(cli())
    finally:
        set_phase("shutdown")
