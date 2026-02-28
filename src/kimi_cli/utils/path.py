from __future__ import annotations

import asyncio
import os
import re
from collections import deque
from collections.abc import Callable, Sequence
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
    """Return an ``ls``-like listing of *work_dir*.

    This helper is used mainly to provide context to the LLM (for example
    ``KIMI_WORK_DIR_LS``) and to show top-level directory contents in tools.
    It should therefore be robust against per-entry filesystem issues such as
    broken symlinks or permission errors: a single bad entry must not crash
    the whole CLI.
    """

    entries: list[str] = []
    # Iterate entries; tolerate per-entry stat failures (broken symlinks, permissions, etc.).
    async for entry in work_dir.iterdir():
        try:
            st = await entry.stat()
        except OSError:
            # Broken symlink, permission error, etc. – keep listing other entries.
            entries.append(f"?--------- {'?':>10} {entry.name} [stat failed]")
            continue
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


class PathTrieNode:
    """A node in the path trie representing a directory entry.

    Each node tracks:
    - name: the entry name (basename, used as dict key in parent)
    - full_path: the relative path from root to this node (as PurePath)
    - is_dir: whether this is a directory
    - children: child nodes (lazily populated)
    - visited: whether this node's children have been scanned
    """

    name: str
    full_path: PurePath
    is_dir: bool
    children: dict[str, PathTrieNode] | None
    visited: bool

    __slots__ = ("name", "full_path", "is_dir", "children", "visited")

    def __init__(self, name: str, full_path: PurePath, is_dir: bool = False) -> None:
        self.name = name
        self.full_path = full_path
        self.is_dir = is_dir
        self.children = None
        self.visited = False

    def get_or_create_child(self, name: str, is_dir: bool = False) -> PathTrieNode:
        """Get or create a child node with the given name.

        The child's full_path is computed as parent.full_path / name.
        """
        if self.children is None:
            self.children = {}
        if name not in self.children:
            child_full_path = self.full_path / name
            self.children[name] = PathTrieNode(name, child_full_path, is_dir)
        return self.children[name]


class PathTrie:
    """A trie data structure for storing and incrementally collecting file paths.

    The trie is built lazily by depth levels:
    - Initially collects paths up to FIRST_STAGE_LIMIT (to ensure shallow files are included)
    - When user types "/", deeper levels are scanned on demand
    - BFS ensures shallow paths are collected before deep-nested ones, preventing
      shallow files from being missed due to slot limits
    """

    # Number of paths to collect initially: ensures shallow files are included while
    # still collecting deep enough to provide a pool for fuzzy matching.
    FIRST_STAGE_LIMIT: int = 200

    root: Path
    check_ignored: Callable[[str], bool]
    limit: int
    root_node: PathTrieNode
    collected_paths: list[PurePath]  # All paths collected so far via BFS traversal
    _dirs_to_scan: deque[tuple[PathTrieNode, int]]  # (node, depth) queue for BFS traversal
    reach_depth: int  # Maximum depth level that has been completely collected

    def __init__(self, root: Path, check_ignored: Callable[[str], bool], limit: int) -> None:
        self.root = root
        self.check_ignored = check_ignored
        self.limit = limit
        self.root_node = PathTrieNode("", PurePath(""), is_dir=True)
        self.root_node.visited = True  # Root is always "visited"
        self.collected_paths = []
        # BFS queue of (node, depth) tuples for incremental directory scanning.
        # Front: directories at the current depth being processed.
        # Back: deeper directories discovered from scanning the front.
        self._dirs_to_scan = deque([(self.root_node, 0)])
        self.reach_depth = -1  # No levels collected yet

    def depth_of(self, path: PurePath) -> int:
        """Calculate depth of a path (root = 0, direct children = 1, etc.)."""
        return len(path.parts)

    def scan_node(self, node: PathTrieNode) -> None:
        """Scan a directory node and populate its children."""
        if node.children is not None:
            return  # Already scanned

        # Build the absolute path for this node (use Path for filesystem access)
        # root is Path, full_path is PurePath, / operator handles the conversion
        abs_path = self.root / node.full_path

        try:
            # Sort entries for deterministic ordering
            entries = tuple(sorted(abs_path.iterdir(), key=lambda p: p.name))
        except OSError:
            return

        for entry in entries:
            name = entry.name
            if self.check_ignored(name):
                continue

            # Check limit before processing more entries
            if len(self.collected_paths) >= self.limit:
                break

            try:
                is_dir = entry.is_dir()
            except OSError:
                continue  # Skip entries we can't stat

            child = node.get_or_create_child(name, is_dir)

            # Add to collection
            self.collected_paths.append(child.full_path)

    def collect_to_depth(self, target_depth: int) -> None:
        """Collect all paths up to and including target_depth.

        Each call processes one BFS level at a time.
        """
        while self._dirs_to_scan and self.reach_depth < target_depth:
            # Process all nodes at the current front depth level
            _n, current_depth = self._dirs_to_scan[0]
            if current_depth > target_depth:
                break

            # Collect all nodes at this depth level
            # Count nodes at current depth (stop early if limit already reached)
            level_size = 0
            for _n, d in self._dirs_to_scan:
                if d != current_depth:
                    break
                if len(self.collected_paths) >= self.limit:
                    return
                level_size += 1

            for _i in range(level_size):
                if not self._dirs_to_scan:
                    break
                node, depth = self._dirs_to_scan.popleft()

                if depth == 0:
                    # Root node - scan it directly (depth 0 is root, children will be depth 1)
                    self.scan_node(node)
                    # Check limit after scanning to stop early
                    if len(self.collected_paths) >= self.limit:
                        break
                    if node.children:
                        for child in sorted(node.children.values(), key=lambda c: c.name):
                            if child.is_dir:
                                self._dirs_to_scan.append((child, depth + 1))
                elif node.is_dir and not node.visited:
                    node.visited = True
                    self.scan_node(node)
                    # Check limit after scanning to stop early
                    if len(self.collected_paths) >= self.limit:
                        break
                    # Add subdirectories to the queue for next BFS level
                    if node.children:
                        for child in sorted(node.children.values(), key=lambda c: c.name):
                            if child.is_dir:
                                self._dirs_to_scan.append((child, depth + 1))

            self.reach_depth = current_depth

            # Check limit after each level
            if len(self.collected_paths) >= self.limit:
                break

    def ensure_depth(self, min_depth: int) -> None:
        """Ensure paths are collected up to min_depth."""
        if min_depth > self.reach_depth:
            self.collect_to_depth(min_depth)

    def collect_first_stage(self) -> None:
        """Collect paths until we have at least FIRST_STAGE_LIMIT paths.

        Collects level by level (BFS) until the limit is reached.
        Respects the hard limit (self.limit).
        """
        while (
            self._dirs_to_scan
            and len(self.collected_paths) < self.FIRST_STAGE_LIMIT
            and len(self.collected_paths) < self.limit
        ):
            # Process next level
            _n, target_depth = self._dirs_to_scan[0]
            self.collect_to_depth(target_depth)

    def get_paths(self, max_depth: int | None = None) -> tuple[PurePath, ...]:
        """Get collected paths up to max_depth.

        If max_depth is None, collects until FIRST_STAGE_LIMIT is reached
        (to ensure shallow files are included), then returns all collected paths.
        """
        if max_depth is None:
            # No specific depth required: ensure shallow files are included
            self.collect_first_stage()
            return tuple(self.collected_paths[: self.limit])
        # Navigation mode: ensure specific depth
        self.ensure_depth(max_depth)
        # Collect paths up to max_depth, breaking early when limit is reached
        # BFS orders paths by depth, so we stop when depth exceeds max_depth
        result: list[PurePath] = []
        for p in self.collected_paths:
            if self.depth_of(p) > max_depth:
                break  # BFS guarantees deeper paths come after; we're done
            result.append(p)
            if len(result) >= self.limit:
                break
        return tuple(result)

    def get_top_level_paths(self) -> tuple[PurePath, ...]:
        """Get only top-level paths (direct children of root, depth 1)."""
        self.ensure_depth(1)
        # Collect depth-1 paths only, breaking early when limit is reached
        # Since BFS orders paths by depth, depth-1 paths are contiguous at the start
        result: list[PurePath] = []
        for p in self.collected_paths:
            if self.depth_of(p) != 1:
                break  # BFS guarantees depth-1 paths come first; we're done
            result.append(p)
            if len(result) >= self.limit:
                break
        return tuple(result)

    def is_directory(self, path: PurePath) -> bool:
        """Check if a path is a directory by looking it up in the trie."""
        if not path.parts:
            return True  # Root is a directory

        # Navigate the trie to find the node
        node = self.root_node
        for part in path.parts:
            if node.children is None or part not in node.children:
                # Not found in trie, fall back to filesystem check
                try:
                    return (self.root / path).is_dir()
                except OSError:
                    return False
            node = node.children[part]
        return node.is_dir
