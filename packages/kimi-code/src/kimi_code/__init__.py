"""Legacy `kimi-code` package on PyPI.

This package used to be an alias of the Python Kimi CLI, which has been archived.
It is NOT the new Kimi Code CLI; running it only prints how to install the new one.
"""

from __future__ import annotations

import sys

MESSAGE = """\
kimi-code on PyPI is a legacy package and is no longer maintained.
It is NOT the new Kimi Code CLI.

Install Kimi Code CLI:
  macOS / Linux:  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
  Windows:        irm https://code.kimi.com/kimi-code/install.ps1 | iex

Then uninstall this package:  uv tool uninstall kimi-code   (or: pip uninstall kimi-code)
Migration guide: https://moonshotai.github.io/kimi-code/en/guides/migration

PyPI 上的 kimi-code 是已停止维护的旧版包，并不是新版 Kimi Code CLI。
请使用上面的命令安装新版。迁移指南：https://moonshotai.github.io/kimi-code/zh/guides/migration
"""


def main() -> int:
    print(MESSAGE, file=sys.stderr)
    return 1
