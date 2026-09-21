from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path
from typing import Any, cast

import aiohttp

from kimi_cli.share import get_share_dir
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger

BASE_URL = "https://cdn.kimi.com/binaries/kimi-cli"
LATEST_VERSION_URL = f"{BASE_URL}/latest"
INSTALL_DIR = Path.home() / ".local" / "bin"

KIMI_CODE_TIPS_URL = "https://cdn.kimi.com/kimi-code-tips/kimi_cli/migration.json"
KIMI_CODE_TIPS_FILE = get_share_dir() / "kimi_code_tips.json"

# The new Kimi Code (TS) install destination for direct platform downloads.
KIMI_CODE_BIN_DIR = Path.home() / ".kimi-code" / "bin"

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


@dataclass(slots=True)
class _PlatformDownload:
    url: str
    sha256: str


@dataclass(slots=True)
class KimiCodeTips:
    """Parsed `kimi-code-tips.json` payload: deprecation & migration notice."""

    enabled: bool
    message: dict[str, str]
    migration_version: str
    min_cli_version: str
    platforms: dict[str, _PlatformDownload]
    install_sh: str
    install_ps1: str
    links: dict[str, str]


_DEFAULT_INSTALL_SH = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
_DEFAULT_INSTALL_PS1 = "irm https://code.kimi.com/kimi-code/install.ps1 | iex"


def _as_str_dict(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    items = cast(Mapping[str, Any], value)
    result: dict[str, str] = {}
    for key, item in items.items():
        if not isinstance(item, str):
            return None
        result[key] = item
    return result


def parse_tips(data: object) -> KimiCodeTips | None:
    """Validate a decoded kimi-code-tips JSON payload.

    Returns None when the payload is malformed. `enabled: false` is a valid
    remote kill switch and parses without a migration block.
    """
    if not isinstance(data, dict):
        return None
    payload = cast(Mapping[str, Any], data)
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return None
    message = _as_str_dict(payload.get("message"))
    if message is None:
        return None
    links = _as_str_dict(payload.get("links")) or {}

    migration_obj = payload.get("migration")
    if not isinstance(migration_obj, dict):
        if enabled:
            return None
        migration_obj = {}
    migration = cast(Mapping[str, Any], migration_obj)
    version = migration.get("version", "")
    if not isinstance(version, str):
        return None
    min_cli_version = migration.get("min_cli_version", "0.0.0")
    if not isinstance(min_cli_version, str):
        return None
    platforms_obj = migration.get("platforms", {})
    if not isinstance(platforms_obj, dict):
        return None
    platforms_raw = cast(Mapping[str, Any], platforms_obj)
    platforms: dict[str, _PlatformDownload] = {}
    for target, info_obj in platforms_raw.items():
        if not isinstance(info_obj, dict):
            return None
        info = cast(Mapping[str, Any], info_obj)
        url = info.get("url")
        sha256 = info.get("sha256", "")
        if not isinstance(url, str) or not url:
            return None
        if not isinstance(sha256, str):
            return None
        platforms[target] = _PlatformDownload(url=url, sha256=sha256)
    install_script_obj = migration.get("install_script", {})
    if not isinstance(install_script_obj, dict):
        return None
    install_script = cast(Mapping[str, Any], install_script_obj)
    install_sh = install_script.get("sh", _DEFAULT_INSTALL_SH)
    install_ps1 = install_script.get("ps1", _DEFAULT_INSTALL_PS1)
    if not isinstance(install_sh, str) or not isinstance(install_ps1, str):
        return None

    return KimiCodeTips(
        enabled=enabled,
        message=message,
        migration_version=version,
        min_cli_version=min_cli_version,
        platforms=platforms,
        install_sh=install_sh,
        install_ps1=install_ps1,
        links=links,
    )


def _is_zh_locale() -> bool:
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        value = os.environ.get(var, "")
        if value:
            return value.lower().startswith("zh")
    return False


def pick_localized(mapping: dict[str, str]) -> str:
    zh = mapping.get("zh", "")
    en = mapping.get("en", "")
    if _is_zh_locale():
        return zh or en
    return en or zh


def _read_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def load_cached_tips() -> KimiCodeTips | None:
    """Read the locally cached tips JSON; None when absent or invalid."""
    try:
        raw = KIMI_CODE_TIPS_FILE.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        logger.warning("Ignoring malformed cached tips file: {path}", path=KIMI_CODE_TIPS_FILE)
        return None
    return parse_tips(data)


async def _fetch_tips(session: aiohttp.ClientSession) -> KimiCodeTips | None:
    """Fetch tips JSON from the CDN; refresh the local cache on success.

    A failed fetch keeps whatever cache exists (including a disabled notice
    that was previously downloaded).
    """
    try:
        async with session.get(KIMI_CODE_TIPS_URL) as resp:
            resp.raise_for_status()
            raw = await resp.text()
    except (TimeoutError, aiohttp.ClientError) as exc:
        logger.debug("Failed to fetch kimi-code tips: {exc}", exc=exc)
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        logger.warning("Tips payload is not valid JSON")
        return None
    tips = parse_tips(data)
    if tips is None:
        logger.warning("Tips payload failed validation")
        return None
    with contextlib.suppress(OSError):
        KIMI_CODE_TIPS_FILE.write_text(raw, encoding="utf-8")
    return tips


def should_show_migration(tips: KimiCodeTips, current_version: str) -> bool:
    """Whether the deprecation/migration notice should be shown for this CLI version."""
    from kimi_cli.ui.shell.migration_nudge import kimi_code_installed

    if not tips.enabled or not tips.migration_version:
        return False
    if kimi_code_installed():
        return False  # already migrated; don't nag
    return semver_tuple(current_version) >= semver_tuple(tips.min_cli_version)


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


async def check_update_gate() -> None:
    """Block interactive shell startup if an action is pending.

    A pending newer Python version shows the classic update gate; otherwise an
    active deprecation notice shows the migration gate. A version skipped by the
    user only suppresses its own branch — a skipped Python update must not hide
    the migration notice.
    """
    import sys

    from kimi_cli.constant import VERSION as current_version
    from kimi_cli.utils.envvar import get_env_bool

    if get_env_bool("KIMI_CLI_NO_AUTO_UPDATE"):
        return
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return

    latest_version = _read_text_file(LATEST_VERSION_FILE)
    if (
        latest_version
        and semver_tuple(latest_version) > semver_tuple(current_version)
        and _read_text_file(SKIPPED_VERSION_FILE) != latest_version
    ):
        _run_update_gate(current_version, latest_version)
        return
    # Otherwise: no pending Python update, or the user skipped it — evaluate the
    # migration notice either way (a skipped Python update must not hide it).

    tips = load_cached_tips()
    if tips is not None and should_show_migration(tips, current_version):
        from kimi_cli.telemetry import track

        track("migration_prompted", current=current_version, target=tips.migration_version)
        await _run_migration_gate(current_version, tips)


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


def _sha256_matches(path: str, expected: str) -> bool:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 64), b""):
            digest.update(chunk)
    return digest.hexdigest().lower() == expected.strip().lower()


def _link_path_shim(dest_path: Path) -> bool:
    """Symlink ~/.local/bin/kimi at the new binary so `kimi` resolves to it."""
    import sys

    if sys.platform == "win32":
        return False
    shim = INSTALL_DIR / "kimi"
    try:
        shim.parent.mkdir(parents=True, exist_ok=True)
        if shim.exists() or shim.is_symlink():
            if shim.is_dir():
                return False
            shim.unlink()
        shim.symlink_to(dest_path)
        return True
    except OSError:
        logger.exception("Failed to update PATH shim:")
        return False


def _run_install_script(tips: KimiCodeTips) -> bool:
    """Fallback migration path: the official Kimi Code install script."""
    import sys

    if sys.platform == "win32":
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            tips.install_ps1,
        ]
    else:
        cmd = ["bash", "-c", tips.install_sh]
    console.print("[grey50]Running install script...[/grey50]")
    try:
        result = subprocess.run(cmd)
    except OSError:
        logger.exception("Failed to run install script:")
        return False
    return result.returncode == 0


async def _download_and_install(download: _PlatformDownload) -> bool:
    filename = download.url.rsplit("/", 1)[-1] or "kimi-code.tar.gz"
    download_timeout = aiohttp.ClientTimeout(total=600, sock_read=60, sock_connect=15)
    async with new_client_session(timeout=download_timeout) as session:
        with tempfile.TemporaryDirectory(prefix="kimi-code-") as tmpdir:
            tar_path = os.path.join(tmpdir, filename)
            logger.info("Downloading Kimi Code from {url}...", url=download.url)
            try:
                async with session.get(download.url) as resp:
                    resp.raise_for_status()
                    with open(tar_path, "wb") as f:
                        async for chunk in resp.content.iter_chunked(1024 * 64):
                            if chunk:
                                f.write(chunk)
            except (TimeoutError, aiohttp.ClientError):
                logger.exception("Failed to download Kimi Code from {url}", url=download.url)
                console.print("[red]Failed to download.[/red]")
                return False
            except Exception:
                logger.exception("Failed to download:")
                console.print("[red]Failed to download.[/red]")
                return False

            if download.sha256 and not _sha256_matches(tar_path, download.sha256):
                logger.error("Checksum mismatch for {url}", url=download.url)
                console.print("[red]Downloaded file checksum mismatch.[/red]")
                return False

            logger.info("Extracting archive {tar_path}...", tar_path=tar_path)
            console.print("[grey50]Extracting...[/grey50]")
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
                    console.print("[red]Binary 'kimi' not found in archive.[/red]")
                    return False
            except Exception:
                logger.exception("Failed to extract archive:")
                console.print("[red]Failed to extract archive.[/red]")
                return False

            logger.info("Installing to {dest}...", dest=KIMI_CODE_BIN_DIR / "kimi")
            console.print("[grey50]Installing...[/grey50]")
            try:
                KIMI_CODE_BIN_DIR.mkdir(parents=True, exist_ok=True)
                dest_path = KIMI_CODE_BIN_DIR / "kimi"
                shutil.copy2(binary_path, dest_path)
                os.chmod(
                    dest_path,
                    os.stat(dest_path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH,
                )
            except Exception:
                logger.exception("Failed to install:")
                console.print("[red]Failed to install.[/red]")
                return False

    if not _link_path_shim(KIMI_CODE_BIN_DIR / "kimi"):
        console.print(
            f"[yellow]Installed to {KIMI_CODE_BIN_DIR}/kimi but could not update PATH.[/yellow]"
        )
    return True


async def _migrate_to_kimi_code(tips: KimiCodeTips) -> bool:
    """Install the new Kimi Code: direct platform download, install script fallback."""
    target = _detect_target()
    download = tips.platforms.get(target) if target else None
    if download is not None:
        console.print("[grey50]Downloading the new Kimi Code...[/grey50]")
        if await _download_and_install(download):
            return True
        console.print(
            "[yellow]Direct download failed, falling back to the install script.[/yellow]"
        )
    else:
        console.print(
            "[grey50]No direct download for this platform; using the install script.[/grey50]"
        )
    return _run_install_script(tips)


async def _run_migration_gate(current_version: str, tips: KimiCodeTips) -> None:
    """Display the red deprecation panel and act on the user's choice."""
    import sys

    from rich.panel import Panel
    from rich.rule import Rule
    from rich.text import Text

    zh = _is_zh_locale()
    title = "kimi-cli 已停止维护" if zh else "kimi-cli is no longer maintained"
    notice = pick_localized(tips.message)
    link = pick_localized(tips.links)

    body = Text.assemble(
        (notice + "\n\n", ""),
        ("  Current version   ", ""),
        (current_version + "\n", ""),
    )
    if link:
        body.append_text(Text.assemble(("  Details: ", ""), (link + "\n", "dodger_blue1")))

    console.print()
    console.print(
        Panel(
            body,
            title=f"[bold]{title}[/bold]",
            border_style="red",
            expand=False,
            padding=(1, 2),
        )
    )
    console.print(Rule(style="grey50"))
    console.print(
        Text.assemble(
            "  ",
            ("[Enter]", "bold"),
            "  Migrate now (downloads & installs the new Kimi Code)",
        )
    )
    console.print(
        Text.assemble("  ", ("[q]", "bold"), "      Continue with this unmaintained version")
    )
    console.print(Rule(style="grey50"))
    console.print()

    key = _read_key()
    console.print()

    if key in ("\r", "\n"):
        migrated = await _migrate_to_kimi_code(tips)
        if migrated:
            console.print(
                "\n[green]Migration complete! Open a new terminal and run "
                "[bold]kimi[/bold] to start the new Kimi Code.[/green]"
            )
            sys.exit(0)
        console.print("[red]Migration failed. You can retry later by running:[/red]")
        console.print(f"  {tips.install_sh if sys.platform != 'win32' else tips.install_ps1}")
        sys.exit(1)
    if key in ("\x03", "\x1b"):
        sys.exit(0)
    # q/Q/other: fall through, continue startup


async def _do_update(*, print: bool, check_only: bool) -> UpdateResult:
    from kimi_cli.constant import VERSION as current_version

    def _print(message: str) -> None:
        if print:
            console.print(message)

    # Version check is fast, but the binary download can be large on slow links.
    download_timeout = aiohttp.ClientTimeout(total=600, sock_read=60, sock_connect=15)
    async with new_client_session(timeout=download_timeout) as session:
        # Refresh the deprecation/migration notice on every check, even on platforms
        # without binary update support (e.g. Windows) — they can still migrate.
        await _fetch_tips(session)

        target = _detect_target()
        if not target:
            _print("[red]Failed to detect target platform.[/red]")
            return UpdateResult.UNSUPPORTED

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
