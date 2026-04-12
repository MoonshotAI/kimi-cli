from __future__ import annotations

import sys

from kimi_cli.cli import cli

if __name__ == "__main__":
    from kimi_cli.utils.encoding import ensure_utf8
    from kimi_cli.utils.proxy import normalize_proxy_env

    ensure_utf8()
    normalize_proxy_env()
    sys.exit(cli())
