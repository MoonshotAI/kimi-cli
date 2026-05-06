from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Sequence
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


_LIST_DIR_ROOT_WIDTH = 30  # worst-case ~330 lines ≈ 2.5k tokens
_LIST_DIR_CHILD_WIDTH = 10


async def _collect_entries(
    dir_path: KaosPath, max_width: int
) -> tuple[list[tuple[str, bool]], int]:
    """Collect up to *max_width* entries from *dir_path*.

    Returns ``(entries, total_count)`` where each entry is ``(name, is_dir)``.
    All entries are stat-ed, sorted directories-first then alphabetically,
    and truncated to *max_width* so the returned subset is deterministic
    regardless of filesystem enumeration order.
    """
    all_entries: list[tuple[str, bool]] = []
    async for entry in dir_path.iterdir():
        try:
            st = await entry.stat()
            is_dir = S_ISDIR(st.st_mode)
        except OSError:
            is_dir = False
        all_entries.append((entry.name, is_dir))
    all_entries.sort(key=lambda e: (not e[1], e[0]))
    return all_entries[:max_width], len(all_entries)


async def list_directory(work_dir: KaosPath) -> str:
    """Return a compact tree listing of *work_dir* (up to 2 levels).

    This helper is used mainly to provide context to the LLM (for example
    ``KIMI_WORK_DIR_LS``) and to show top-level directory contents in tools.

    Both depth and width are capped to keep the system-prompt token budget
    bounded (see GH-1809):

    * **Depth 0** (root): up to :data:`_LIST_DIR_ROOT_WIDTH` entries.
    * **Depth 1** (children of root dirs): up to :data:`_LIST_DIR_CHILD_WIDTH`
      entries per directory.
    * Truncated levels show ``... and N more`` so the LLM knows more exists.
    """
    lines: list[str] = []
    entries, total = await _collect_entries(work_dir, _LIST_DIR_ROOT_WIDTH)
    remaining = total - len(entries)

    for i, (name, is_dir) in enumerate(entries):
        is_last = (i == len(entries) - 1) and remaining == 0
        connector = "└── " if is_last else "├── "

        if is_dir:
            lines.append(f"{connector}{name}/")
            child_prefix = "    " if is_last else "│   "
            try:
                child_entries, child_total = await _collect_entries(
                    work_dir / name, _LIST_DIR_CHILD_WIDTH
                )
            except OSError:
                lines.append(f"{child_prefix}└── [not readable]")
                continue
            child_remaining = child_total - len(child_entries)
            for j, (child_name, child_is_dir) in enumerate(child_entries):
                child_is_last = (j == len(child_entries) - 1) and child_remaining == 0
                child_connector = "└── " if child_is_last else "├── "
                suffix = "/" if child_is_dir else ""
                lines.append(f"{child_prefix}{child_connector}{child_name}{suffix}")
            if child_remaining > 0:
                lines.append(f"{child_prefix}└── ... and {child_remaining} more")
        else:
            lines.append(f"{connector}{name}")

    if remaining > 0:
        lines.append(f"└── ... and {remaining} more entries")

    return "\n".join(lines) if lines else "(empty directory)"


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


def sanitize_cli_path(raw: str) -> str:
    """Strip surrounding quotes from a CLI path argument.

    On macOS, dragging a file into the terminal wraps the path in single
    quotes (e.g. ``'/path/to/file'``).  This helper strips matching outer
    quotes (single or double) so downstream path handling works correctly.
    """
    raw = raw.strip()
    if len(raw) >= 2 and ((raw[0] == "'" and raw[-1] == "'") or (raw[0] == '"' and raw[-1] == '"')):
        raw = raw[1:-1]
    return raw


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


def is_within_workspace(
    path: KaosPath,
    work_dir: KaosPath,
    additional_dirs: Sequence[KaosPath] = (),
) -> bool:
    """
    Check whether *path* is within the workspace (work_dir or any additional directory).
    """
    if is_within_directory(path, work_dir):
        return True
    return any(is_within_directory(path, d) for d in additional_dirs)


async def find_project_root(work_dir: KaosPath) -> KaosPath:
    """Walk up from *work_dir* to find the nearest directory containing ``.git``.

    Returns *work_dir* itself if no ``.git`` marker is found before reaching the
    filesystem root. Used by AGENTS.md discovery and by resolving relative
    ``extra_skill_dirs`` entries to the project root (not the CWD).
    """
    current = work_dir
    while True:
        if await (current / ".git").exists():
            return current
        parent = current.parent
        if parent == current:  # filesystem root
            return work_dir
        current = parent
