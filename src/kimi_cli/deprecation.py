"""Deprecation gate for the archived kimi-cli package.

The Python kimi-cli is no longer maintained; the Kimi Code CLI (TypeScript) is
its successor. In this final release every entry point is short-circuited:

- no arguments: fetch the Kimi Code install script from the CDN and run it
  directly (no confirmation), so CDN-side script updates take effect without
  a new package release;
- ``--version``: print the version plus the deprecation notice;
- anything else (subcommands, ``-p``, ``--help``, ...): print the one-line
  deprecation notice only.

The original Typer CLI is kept in the tree but is no longer reachable from the
package entry point.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

_INSTALL_SH = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
_INSTALL_PS1 = "irm https://code.kimi.com/kimi-code/install.ps1 | iex"

_MESSAGE_ZH = "kimi-cli 已停止维护，请使用新版 Kimi Code CLI。安装：{cmd}"
_MESSAGE_EN = "kimi-cli is no longer maintained. Please use the new Kimi Code CLI. Install: {cmd}"


def _is_zh_locale() -> bool:
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        value = os.environ.get(var, "")
        if value:
            return value.lower().startswith("zh")
    return False


def _tips_cache_file():
    from kimi_cli.share import get_share_dir

    return get_share_dir() / "kimi_code_tips.json"


def _cached_install_scripts() -> tuple[str, str] | None:
    """Read the (sh, ps1) install commands from the locally cached CDN tips.

    The cache is refreshed by every no-argument run (and by older interactive
    versions' update checks). Returns None when absent or malformed. Kept
    dependency-light so the ``--version`` fast path stays fast.
    """
    try:
        data = json.loads(_tips_cache_file().read_text(encoding="utf-8"))
        script = data["migration"]["install_script"]
        sh, ps1 = script["sh"], script["ps1"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(sh, str) or not sh or not isinstance(ps1, str) or not ps1:
        return None
    return sh, ps1


def install_command() -> str:
    """The install command shown to users for their platform.

    Follows the CDN tips when a local cache exists, so a CDN-side change of
    the install script URL is reflected in the notice; otherwise falls back to
    the built-in default.
    """
    scripts = _cached_install_scripts()
    if scripts is not None:
        return scripts[1] if sys.platform == "win32" else scripts[0]
    return _INSTALL_PS1 if sys.platform == "win32" else _INSTALL_SH


def deprecation_message() -> str:
    """The one-line deprecation notice printed by every short-circuited entry point."""
    template = _MESSAGE_ZH if _is_zh_locale() else _MESSAGE_EN
    return template.format(cmd=install_command())


async def _fetch_install_scripts() -> tuple[str, str]:
    """Fetch the install script commands from the CDN migration tips payload.

    Falls back to the locally cached tips, then to the built-in defaults, so a
    CDN or network failure still leaves a working install command.
    """
    from kimi_cli.ui.shell.update import fetch_install_scripts

    try:
        scripts = await fetch_install_scripts()
    except Exception:
        scripts = None
    return scripts if scripts is not None else (_INSTALL_SH, _INSTALL_PS1)


def run_kimi_code_installer() -> int:
    """Download and run the Kimi Code install script from the CDN, without confirmation."""
    import asyncio

    zh = _is_zh_locale()
    print(deprecation_message())
    if zh:
        print("正在运行 Kimi Code 安装脚本...")
    else:
        print("Running the Kimi Code install script...")

    try:
        install_sh, install_ps1 = asyncio.run(_fetch_install_scripts())
    except Exception:
        install_sh, install_ps1 = _INSTALL_SH, _INSTALL_PS1

    if sys.platform == "win32":
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", install_ps1]
    else:
        # pipefail so a failure anywhere in the piped install script (e.g. missing
        # curl) is reflected in the exit code instead of being masked by the
        # right-hand side of the pipe.
        cmd = ["bash", "-o", "pipefail", "-c", install_sh]

    try:
        returncode = subprocess.run(cmd).returncode
    except OSError:
        returncode = 1

    if returncode != 0:
        if zh:
            print(f"安装失败。请稍后重试，或手动运行：\n  {install_command()}")
        else:
            print(
                f"Installation failed. Please retry later, or run manually:\n  {install_command()}"
            )
        return returncode

    if zh:
        print("安装完成！请打开一个新的终端，运行 kimi 启动新版 Kimi Code。")
    else:
        print("Done! Open a new terminal and run kimi to start the new Kimi Code.")
    return 0
