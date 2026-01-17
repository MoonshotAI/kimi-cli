from __future__ import annotations

import asyncio
import os
import platform
import re
import shutil
import stat
import tarfile
import tempfile
from enum import Enum, auto
from pathlib import Path

import aiohttp

from gitrekt_cli.share import get_share_dir
from gitrekt_cli.ui.shell.console import console
from gitrekt_cli.utils.aiohttp import new_client_session
from gitrekt_cli.utils.logging import logger

BASE_URL = "https://cdn.kimi.com/binaries/gitrekt-cli"
LATEST_VERSION_URL = f"{BASE_URL}/latest"
INSTALL_DIR = Path.home() / ".local" / "bin"


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
    except aiohttp.ClientError:
        logger.exception("Failed to get latest version:")
        return None


async def do_update(*, print: bool = True, check_only: bool = False) -> UpdateResult:
    async with _UPDATE_LOCK:
        return await _do_update(print=print, check_only=check_only)


LATEST_VERSION_FILE = get_share_dir() / "latest_version.txt"


async def _do_update(*, print: bool, check_only: bool) -> UpdateResult:
    from gitrekt_cli.constant import VERSION as current_version

    def _print(message: str) -> None:
        if print:
            console.print(message)

    target = _detect_target()
    if not target:
        _print("[red]Failed to detect target platform.[/red]")
        return UpdateResult.UNSUPPORTED

    async with new_client_session() as session:
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

        filename = f"gitrekt-{latest_version}-{target}.tar.gz"
        download_url = f"{BASE_URL}/{latest_version}/{filename}"

        with tempfile.TemporaryDirectory(prefix="gitrekt-cli-") as tmpdir:
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
            except aiohttp.ClientError:
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
                    if "gitrekt" in files:
                        binary_path = os.path.join(root, "gitrekt")
                        break
                if not binary_path:
                    logger.error("Binary 'gitrekt' not found in archive.")
                    _print("[red]Binary 'gitrekt' not found in archive.[/red]")
                    return UpdateResult.FAILED
            except Exception:
                logger.exception("Failed to extract archive:")
                _print("[red]Failed to extract archive.[/red]")
                return UpdateResult.FAILED

            INSTALL_DIR.mkdir(parents=True, exist_ok=True)
            dest_path = INSTALL_DIR / "gitrekt"
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
    _print("[yellow]Restart Gitrekt CLI to use the new version.[/yellow]")
    return UpdateResult.UPDATED


# @meta_command
# async def update(app: "Shell", args: list[str]):
#     """Check for updates"""
#     await do_update(print=True)


# @meta_command(name="check-update")
# async def check_update(app: "Shell", args: list[str]):
#     """Check for updates"""
#     await do_update(print=True, check_only=True)
