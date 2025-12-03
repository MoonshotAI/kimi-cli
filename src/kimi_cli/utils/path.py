from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path, PurePath
from stat import S_ISDIR

import aiofiles.os
from kaos.path import KaosPath

_ROTATION_OPEN_FLAGS = os.O_CREAT | os.O_EXCL | os.O_WRONLY
_ROTATION_FILE_MODE = 0o600


async def _reserve_rotation_path(path: Path) -> bool:
    """Atomically create an empty file as a reservation for *path*."""

    def _create() -> None:
        fd = os.open(str(path), _ROTATION_OPEN_FLAGS, _ROTATION_FILE_MODE)
        os.close(fd)

    try:
        await asyncio.to_thread(_create)
    except FileExistsError:
        return False
    return True


async def next_available_rotation(path: Path) -> Path | None:
    """Return a reserved rotation path for *path* or ``None`` if parent is missing.

    The caller must overwrite/reuse the returned path immediately because this helper
    commits an empty placeholder file to guarantee uniqueness. It is therefore suited
    for rotating *files* (like history logs) but **not** directory creation.
    """

    if not path.parent.exists():
        return None

    base_name = path.stem
    suffix = path.suffix
    pattern = re.compile(rf"^{re.escape(base_name)}_(\d+){re.escape(suffix)}$")
    max_num = 0
    for entry in await aiofiles.os.listdir(path.parent):
        if match := pattern.match(entry):
            max_num = max(max_num, int(match.group(1)))

    next_num = max_num + 1
    while True:
        next_path = path.parent / f"{base_name}_{next_num}{suffix}"
        if await _reserve_rotation_path(next_path):
            return next_path
        next_num += 1


async def list_directory(work_dir: KaosPath) -> str:
    entries: list[str] = []
    async for entry in await work_dir.iterdir():
        st = await entry.stat()
        mode = "d" if S_ISDIR(st.st_mode) else "-"
        mode += "r" if st.st_mode & 0o400 else "-"
        mode += "w" if st.st_mode & 0o200 else "-"
        mode += "x" if st.st_mode & 0o100 else "-"
        mode += "r" if st.st_mode & 0o040 else "-"
        mode += "w" if st.st_mode & 0o020 else "-"
        mode += "x" if st.st_mode & 0o010 else "-"
        mode += "r" if st.st_mode & 0o004 else "-"
        mode += "w" if st.st_mode & 0o002 else "-"
        mode += "x" if st.st_mode & 0o001 else "-"
        entries.append(f"{mode} {st.st_size:>10} {entry.name}")
    return "\n".join(entries)


def shorten_home(path: KaosPath) -> KaosPath:
    """
    Convert absolute path to use `~` for home directory.
    """
    try:
        home = KaosPath.home()
        p = path.relative_to(home)
        return KaosPath("~") / p
    except Exception:
        return path


def is_within_directory(path: KaosPath, directory: KaosPath) -> bool:
    """
    Check whether *path* is contained within *directory* using pure path semantics.
    Both arguments should already be canonicalized (e.g. via KaosPath.canonical()).
    """
    candidate = PurePath(str(path))
    base = PurePath(str(directory))
    try:
        candidate.relative_to(base)
        return True
    except ValueError:
        return False
