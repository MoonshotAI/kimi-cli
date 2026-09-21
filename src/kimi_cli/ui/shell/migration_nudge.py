from __future__ import annotations

import contextlib
import sys
from datetime import date
from pathlib import Path

from rich.console import Console
from rich.text import Text

from kimi_cli.share import get_share_dir

_INSTALL_SH = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
_INSTALL_PS = "irm https://code.kimi.com/kimi-code/install.ps1 | iex"


def install_command(platform: str) -> str:
    """Return the install command to DISPLAY for the given sys.platform value."""
    if platform == "win32":
        return _INSTALL_PS
    return _INSTALL_SH


def install_run_command(platform: str) -> str:
    """Return the install command in a form runnable via the shell.

    On Windows the displayed PowerShell one-liner (`irm … | iex`) must be wrapped so
    it runs under PowerShell instead of cmd.exe, which is the default shell used to
    execute commands and does not understand PowerShell cmdlets.
    """
    if platform == "win32":
        return f'powershell -NoProfile -ExecutionPolicy Bypass -Command "{_INSTALL_PS}"'
    return _INSTALL_SH


def verify_command(platform: str) -> str:
    """Command to check which `kimi` resolves on PATH (Windows: where, else: which)."""
    return "where kimi" if platform == "win32" else "which kimi"


def kimi_code_installed(home: Path | None = None) -> bool:
    """True if the standalone Kimi Code is installed (its data dir ~/.kimi-code exists)."""
    home = home or Path.home()
    return (home / ".kimi-code").is_dir()


def exit_nudge_marker(share_dir: Path) -> Path:
    """Path of the throttle marker recording the last day the exit nudge was shown."""
    return share_dir / ".migration-nudge"


def should_show_exit_nudge(marker: Path, today: str) -> bool:
    """Return True at most once per calendar day; record `today` when returning True.

    `today` is an ISO date string (e.g. "2026-06-05"), injected for testability.
    """
    try:
        last = marker.read_text(encoding="utf-8").strip()
    except OSError:
        last = ""
    if last == today:
        return False
    with contextlib.suppress(OSError):
        marker.write_text(today, encoding="utf-8")
    return True


def welcome_card_text() -> Text:
    """Welcome-screen card nudging users to upgrade (shown when Kimi Code is NOT installed)."""
    return Text.assemble(
        "The new Kimi Code is here — rebuilt to be faster and more powerful.\n",
        "Run ",
        ("/upgrade", "bold"),
        "; your config & sessions carry over.",
    )


def already_installed_text(platform: str) -> Text:
    """Welcome-screen note shown when Kimi Code IS already installed on this machine."""
    return Text.assemble(
        "The new Kimi Code is already installed. Start it in a fresh terminal with ",
        ("kimi", "bold"),
        " (verify: ",
        (verify_command(platform), "cyan"),
        " → ~/.kimi-code).",
    )


def exit_nudge_text(platform: str) -> Text:
    """Throttled tip printed on graceful exit."""
    return Text.assemble(
        ("Tip: ", "yellow"),
        "The new Kimi Code is rebuilt to be faster and more powerful.\n",
        "Install: ",
        (install_command(platform), "cyan"),
        ("  (or run /upgrade next time)", "grey50"),
    )


def print_migration_goodbye(
    console: Console,
    *,
    home: Path | None = None,
    today: str | None = None,
    platform: str | None = None,
) -> None:
    """Print the farewell ("Bye!") plus, at most once per day, the migration tip.

    Skipped entirely (only "Bye!") if Kimi Code is already installed.
    `home`/`today`/`platform` are injectable for testing; in production they default
    to the real values.
    """
    console.print("Bye!")
    if kimi_code_installed(home):
        return
    today = today or date.today().isoformat()
    platform = platform or sys.platform
    if should_show_exit_nudge(exit_nudge_marker(get_share_dir()), today):
        console.print(exit_nudge_text(platform))
