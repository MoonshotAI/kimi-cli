from __future__ import annotations

import asyncio
import contextlib
import os
import platform
import re
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
from enum import Enum, auto
from pathlib import Path

import aiohttp

from kimi_cli.share import get_share_dir
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger

BASE_URL = "https://cdn.kimi.com/binaries/kimi-cli"
LATEST_VERSION_URL = f"{BASE_URL}/latest"
INSTALL_DIR = Path.home() / ".local" / "bin"

# Upgrade command shown in toast notifications. Can be overridden by wrappers
UPGRADE_COMMAND = "uv tool upgrade kimi-cli"


class UpdateResult(Enum):
    UPDATE_AVAILABLE = auto()
    UPDATED = auto()
    UP_TO_DATE = auto()
    FAILED = auto()
    UNSUPPORTED = auto()


_UPDATE_LOCK = asyncio.Lock()


def semver_tuple(version: str) -> tuple[int, int, int]:
    v = version.strip()
    if v.startswith("v"):
        v = v[1:]
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", v)
    if not match:
        return (0, 0, 0)
    major = int(match.group(1))
    minor = int(match.group(2))
    patch = int(match.group(3) or 0)
    return (major, minor, patch)


def _detect_target() -> str | None:
    sys_name = platform.system()
    mach = platform.machine()
    if mach in ("x86_64", "amd64", "AMD64"):
        arch = "x86_64"
    elif mach in ("arm64", "aarch64"):
        arch = "aarch64"
    else:
        logger.error("Unsupported architecture: {mach}", mach=mach)
        return None
    if sys_name == "Darwin":
        os_name = "apple-darwin"
    elif sys_name == "Linux":
        os_name = "unknown-linux-gnu"
    else:
        logger.error("Unsupported OS: {sys_name}", sys_name=sys_name)
        return None
    return f"{arch}-{os_name}"


async def _get_latest_version(session: aiohttp.ClientSession) -> str | None:
    try:
        async with session.get(LATEST_VERSION_URL) as resp:
            resp.raise_for_status()
            data = await resp.text()
            return data.strip()
    except (TimeoutError, aiohttp.ClientError):
        logger.exception("Failed to get latest version:")
        return None


async def do_update(*, print: bool = True, check_only: bool = False) -> UpdateResult:
    async with _UPDATE_LOCK:
        return await _do_update(print=print, check_only=check_only)


LATEST_VERSION_FILE = get_share_dir() / "latest_version.txt"
SKIPPED_VERSION_FILE = get_share_dir() / "skipped_version.txt"
CHANGELOG_URL_ZH = "https://moonshotai.github.io/kimi-cli/zh/release-notes/changelog.html"
CHANGELOG_URL_EN = "https://moonshotai.github.io/kimi-cli/en/release-notes/changelog.html"


def _read_key() -> str:
    """Read a single character from stdin in raw terminal mode."""
    import sys

    if sys.platform == "win32":
        import msvcrt

        return msvcrt.getwch()
    else:
        import termios
        import tty

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            return sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


def check_update_gate() -> None:
    """Block interactive shell startup if a newer version is cached locally."""
    import sys

    from kimi_cli.constant import VERSION as current_version
    from kimi_cli.utils.envvar import get_env_bool

    if get_env_bool("KIMI_CLI_NO_AUTO_UPDATE"):
        return
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return
    if not LATEST_VERSION_FILE.exists():
        return

    try:
        latest_version = LATEST_VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return
    if semver_tuple(latest_version) <= semver_tuple(current_version):
        return

    if SKIPPED_VERSION_FILE.exists():
        try:
            skipped = SKIPPED_VERSION_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            skipped = ""
        if skipped == latest_version:
            return

    _run_update_gate(current_version, latest_version)


def _run_update_gate(current_version: str, latest_version: str) -> None:
    """Display the blocking update UI and handle user key input."""
    import sys

    from rich.panel import Panel
    from rich.rule import Rule
    from rich.text import Text

    body = Text.assemble(
        ("  Current version   ", ""),
        (current_version + "\n", ""),
        ("  Latest version    ", ""),
        (latest_version + "\n\n", "bold green"),
        ("  What's new:\n", ""),
        ("    · [中文]    ", ""),
        (CHANGELOG_URL_ZH + "\n", "dodger_blue1"),
        ("    · [English] ", ""),
        (CHANGELOG_URL_EN + "\n", "dodger_blue1"),
    )
    console.print()
    console.print(
        Panel(
            body,
            title="[bold]kimi-cli update available[/bold]",
            border_style="yellow",
            expand=False,
            padding=(1, 2),
        )
    )
    console.print(Rule(style="grey50"))
    console.print(
        Text.assemble(
            "  ",
            ("[Enter]", "bold"),
            "  Upgrade now  ",
            (f"({UPGRADE_COMMAND})", "grey50"),
        )
    )
    console.print(Text.assemble("  ", ("[q]", "bold"), "      Not now, remind me next time"))
    console.print(
        Text.assemble("  ", ("[s]", "bold"), f"      Skip reminders for version {latest_version}")
    )
    console.print(Rule(style="grey50"))
    console.print()

    key = _read_key()
    console.print()

    if key in ("\r", "\n"):
        console.print(f"[grey50]Running: {UPGRADE_COMMAND}[/grey50]\n")
        try:
            result = subprocess.run(shlex.split(UPGRADE_COMMAND))
        except OSError:
            console.print()
            console.print("[red]Upgrade failed. Please try running manually:[/red]")
            console.print(f"  {UPGRADE_COMMAND}")
            sys.exit(1)
        console.print()
        if result.returncode == 0:
            console.print("[green]Upgrade complete! Run kimi-cli to start the new version.[/green]")
        else:
            console.print("[red]Upgrade failed. Please try running manually:[/red]")
            console.print(f"  {UPGRADE_COMMAND}")
        sys.exit(result.returncode)
    elif key in ("s", "S"):
        with contextlib.suppress(OSError):
            SKIPPED_VERSION_FILE.write_text(latest_version, encoding="utf-8")
        console.print(f"[grey50]Reminders skipped for version {latest_version}.[/grey50]\n")
    elif key in ("\x03", "\x1b"):
        sys.exit(0)
    # q/Q/other: fall through, continue startup


async def _do_update(*, print: bool, check_only: bool) -> UpdateResult:
    from kimi_cli.constant import VERSION as current_version

    def _print(message: str) -> None:
        if print:
            console.print(message)

    target = _detect_target()
    if not target:
        _print("[red]Failed to detect target platform.[/red]")
        return UpdateResult.UNSUPPORTED

    # Version check is fast, but the binary download can be large on slow links.
    download_timeout = aiohttp.ClientTimeout(total=600, sock_read=60, sock_connect=15)
    async with new_client_session(timeout=download_timeout) as session:
        logger.info("Checking for updates...")
        _print("Checking for updates...")
        latest_version = await _get_latest_version(session)
        if not latest_version:
            _print("[red]Failed to check for updates.[/red]")
            return UpdateResult.FAILED

        logger.debug("Latest version: {latest_version}", latest_version=latest_version)
        LATEST_VERSION_FILE.write_text(latest_version, encoding="utf-8")

        cur_t = semver_tuple(current_version)
        lat_t = semver_tuple(latest_version)

        if cur_t >= lat_t:
            logger.debug("Already up to date: {current_version}", current_version=current_version)
            _print("[green]Already up to date.[/green]")
            return UpdateResult.UP_TO_DATE

        if check_only:
            logger.info(
                "Update available: current={current_version}, latest={latest_version}",
                current_version=current_version,
                latest_version=latest_version,
            )
            _print(f"[yellow]Update available: {latest_version}[/yellow]")
            return UpdateResult.UPDATE_AVAILABLE

        logger.info(
            "Updating from {current_version} to {latest_version}...",
            current_version=current_version,
            latest_version=latest_version,
        )
        _print(f"Updating from {current_version} to {latest_version}...")

        filename = f"kimi-{latest_version}-{target}.tar.gz"
        download_url = f"{BASE_URL}/{latest_version}/{filename}"

        with tempfile.TemporaryDirectory(prefix="kimi-cli-") as tmpdir:
            tar_path = os.path.join(tmpdir, filename)

            logger.info("Downloading from {download_url}...", download_url=download_url)
            _print("[grey50]Downloading...[/grey50]")
            try:
                async with session.get(download_url) as resp:
                    resp.raise_for_status()
                    with open(tar_path, "wb") as f:
                        async for chunk in resp.content.iter_chunked(1024 * 64):
                            if chunk:
                                f.write(chunk)
            except (TimeoutError, aiohttp.ClientError):
                logger.exception(
                    "Failed to download update from {download_url}",
                    download_url=download_url,
                )
                _print("[red]Failed to download.[/red]")
                return UpdateResult.FAILED
            except Exception:
                logger.exception("Failed to download:")
                _print("[red]Failed to download.[/red]")
                return UpdateResult.FAILED

            logger.info("Extracting archive {tar_path}...", tar_path=tar_path)
            _print("[grey50]Extracting...[/grey50]")
            try:
                with tarfile.open(tar_path, "r:gz") as tar:
                    tar.extractall(tmpdir)
                binary_path = None
                for root, _, files in os.walk(tmpdir):
                    if "kimi" in files:
                        binary_path = os.path.join(root, "kimi")
                        break
                if not binary_path:
                    logger.error("Binary 'kimi' not found in archive.")
                    _print("[red]Binary 'kimi' not found in archive.[/red]")
                    return UpdateResult.FAILED
            except Exception:
                logger.exception("Failed to extract archive:")
                _print("[red]Failed to extract archive.[/red]")
                return UpdateResult.FAILED

            INSTALL_DIR.mkdir(parents=True, exist_ok=True)
            dest_path = INSTALL_DIR / "kimi"
            logger.info("Installing to {dest_path}...", dest_path=dest_path)
            _print("[grey50]Installing...[/grey50]")

            try:
                shutil.copy2(binary_path, dest_path)
                os.chmod(
                    dest_path,
                    os.stat(dest_path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH,
                )
            except Exception:
                logger.exception("Failed to install:")
                _print("[red]Failed to install.[/red]")
                return UpdateResult.FAILED

    _print("[green]Updated successfully![/green]")
    _print("[yellow]Restart Kimi Code CLI to use the new version.[/yellow]")
    return UpdateResult.UPDATED


# @meta_command
# async def update(app: "Shell", args: list[str]):
#     """Check for updates"""
#     await do_update(print=True)


# @meta_command(name="check-update")
# async def check_update(app: "Shell", args: list[str]):
#     """Check for updates"""
#     await do_update(print=True, check_only=True)
