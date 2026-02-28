"""Tests for the PathTrie incremental file collection."""

from __future__ import annotations

from pathlib import Path, PurePath

from kimi_cli.utils.path import PathTrie, PathTrieNode


def _is_ignored(name: str) -> bool:
    """Simple ignore function for testing."""
    return name.startswith(".") or name == "__pycache__"


# =============================================================================
# PathTrieNode tests
# =============================================================================


def test_node_creation():
    """Node stores name, full_path, and is_dir correctly."""
    node = PathTrieNode("src", PurePath("src"), is_dir=True)
    assert node.name == "src"
    assert node.full_path == PurePath("src")
    assert node.is_dir is True
    assert node.children is None
    assert node.visited is False


def test_get_or_create_child():
    """Child creation builds correct full_path."""
    root = PathTrieNode("", PurePath(""), is_dir=True)
    child = root.get_or_create_child("src", is_dir=True)

    assert child.name == "src"
    assert child.full_path == PurePath("src")
    assert child.is_dir is True

    # Nested child
    grandchild = child.get_or_create_child("kimi", is_dir=False)
    assert grandchild.name == "kimi"
    assert grandchild.full_path == PurePath("src/kimi")
    assert grandchild.is_dir is False


def test_get_existing_child():
    """Getting existing child returns same instance."""
    root = PathTrieNode("", PurePath(""), is_dir=True)
    child1 = root.get_or_create_child("src", is_dir=True)
    child2 = root.get_or_create_child("src", is_dir=True)

    assert child1 is child2


# =============================================================================
# PathTrie basic tests
# =============================================================================


def test_empty_directory(tmp_path: Path):
    """Trie works with empty root directory."""
    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()
    assert paths == ()


def test_single_file(tmp_path: Path):
    """Single file is collected."""
    (tmp_path / "file.txt").write_text("content")
    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()

    assert len(paths) == 1
    assert paths[0] == PurePath("file.txt")


def test_single_directory(tmp_path: Path):
    """Single directory is collected."""
    (tmp_path / "src").mkdir()
    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()

    assert paths == (PurePath("src"),)


# =============================================================================
# BFS ordering tests
# =============================================================================


def test_shallow_paths_first(tmp_path: Path):
    """BFS ensures shallow paths are collected before deep ones."""
    # Create structure: a/b/c/d/e (deep) and x/y (shallow)
    (tmp_path / "a" / "b" / "c" / "d" / "e").mkdir(parents=True)
    (tmp_path / "x" / "y").mkdir(parents=True)

    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()

    # Verify BFS order: depth 1 (a, x) before depth 2 (a/b, x/y)
    expected = (
        PurePath("a"),
        PurePath("x"),
        PurePath("a/b"),
        PurePath("x/y"),
    )
    assert paths[:4] == expected


def test_breadth_before_depth(tmp_path: Path):
    """Verify specific BFS order: siblings before children."""
    # Create: src/ (with file.py), tests/ (with test.py)
    # BFS should collect: src, tests, src/file.py, tests/test.py
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "file.py").write_text("")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test.py").write_text("")

    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()

    names = [str(p) for p in paths]

    # Both depth-1 items should come before depth-2 items
    depth1_items = ["src", "tests"]
    depth2_items = ["src/file.py", "tests/test.py"]

    max_depth1_pos = max(names.index(n) for n in depth1_items)
    min_depth2_pos = min(names.index(n) for n in depth2_items)

    assert max_depth1_pos < min_depth2_pos, "Depth-1 items should all appear before depth-2 items"


# =============================================================================
# Incremental depth tests
# =============================================================================


def test_initial_depth_limit(tmp_path: Path):
    """Initially only collects up to initial_depth (2 levels)."""
    # Create: a/b/c/d (4 levels deep)
    (tmp_path / "a" / "b" / "c" / "d").mkdir(parents=True)

    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()

    assert PurePath("a") in paths
    assert PurePath("a/b") in paths


def test_incremental_expansion(tmp_path: Path):
    """Deeper paths are collected on demand via ensure_depth."""
    # Create: a/b/c/d (4 levels deep)
    (tmp_path / "a" / "b" / "c" / "d").mkdir(parents=True)

    trie = PathTrie(tmp_path, _is_ignored, limit=100)

    # Initially only depth 1-2
    paths = trie.get_paths(max_depth=2)
    assert PurePath("a") in paths
    assert PurePath("a/b") in paths
    assert PurePath("a/b/c") not in paths

    # Expand to depth 3
    trie.ensure_depth(3)
    paths = trie.get_paths(max_depth=3)
    assert PurePath("a/b/c") in paths
    assert PurePath("a/b/c/d") not in paths

    # Expand to depth 4
    trie.ensure_depth(4)
    paths = trie.get_paths(max_depth=4)
    assert PurePath("a/b/c/d") in paths


def test_get_top_level_paths(tmp_path: Path):
    """get_top_level_paths returns only depth 1 items."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "file.py").write_text("")
    (tmp_path / "README.md").write_text("")

    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    top_level = trie.get_top_level_paths()

    assert len(top_level) == 2
    assert PurePath("src") in top_level
    assert PurePath("README.md") in top_level
    assert PurePath("src/file.py") not in top_level


# =============================================================================
# Limit enforcement tests
# =============================================================================


def test_limit_respected(tmp_path: Path):
    """Total paths collected respects the limit."""
    for i in range(20):
        (tmp_path / f"file{i}.txt").write_text("")

    trie = PathTrie(tmp_path, _is_ignored, limit=10)
    paths = trie.get_paths()

    assert len(paths) <= 10


def test_limit_preserves_shallow_paths(tmp_path: Path):
    """When limit hits, shallow paths are preserved over deep ones."""
    # Structure: a/b/c0../c9/deep.txt (deep), plus x, y (shallow)
    # With limit=4, BFS collects: a, x, y, a/b
    # Deep paths (a/b/c*) should NOT be included
    (tmp_path / "a" / "b" / "c0").mkdir(parents=True)
    for i in range(10):
        (tmp_path / "a" / "b" / f"c{i}").mkdir(exist_ok=True)
        (tmp_path / "a" / "b" / f"c{i}" / "deep.txt").write_text("")

    (tmp_path / "x").mkdir()
    (tmp_path / "y").mkdir()

    limit = 4
    trie = PathTrie(tmp_path, _is_ignored, limit=limit)
    paths = trie.get_paths()

    path_strs = [str(p) for p in paths]
    # Verify shallow paths are included
    assert "a" in path_strs
    assert "x" in path_strs
    assert "y" in path_strs
    assert "a/b" in path_strs
    # Verify deep paths are excluded due to limit
    assert not any("a/b/c" in p for p in path_strs)


# =============================================================================
# is_directory tests
# =============================================================================


def test_is_directory_for_file(tmp_path: Path):
    """is_directory returns False for files."""
    (tmp_path / "file.txt").write_text("content")
    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    trie.get_paths()  # Populate

    assert trie.is_directory(PurePath("file.txt")) is False


def test_is_directory_for_directory(tmp_path: Path):
    """is_directory returns True for directories."""
    (tmp_path / "src").mkdir()
    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    trie.get_paths()  # Populate

    assert trie.is_directory(PurePath("src")) is True


def test_is_directory_for_root(tmp_path: Path):
    """is_directory returns True for root (empty path)."""
    trie = PathTrie(tmp_path, _is_ignored, limit=100)

    assert trie.is_directory(PurePath("")) is True


def test_is_directory_for_unknown_path(tmp_path: Path):
    """is_directory falls back to filesystem check for unknown paths."""
    trie = PathTrie(tmp_path, _is_ignored, limit=100)

    (tmp_path / "unknown").mkdir()
    assert trie.is_directory(PurePath("unknown")) is True


# =============================================================================
# Ignored patterns tests
# =============================================================================


def test_ignored_names_not_collected(tmp_path: Path):
    """Ignored names are not added to the trie."""
    (tmp_path / "src").mkdir()
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "__pycache__").mkdir()

    trie = PathTrie(tmp_path, _is_ignored, limit=100)
    paths = trie.get_paths()

    assert PurePath("src") in paths
    assert PurePath(".hidden") not in paths
    assert PurePath("__pycache__") not in paths


def test_ignored_patterns_not_descended(tmp_path: Path):
    """Ignored directories are not scanned for children."""
    (tmp_path / "node_modules" / "package" / "file.js").mkdir(parents=True)

    def ignore_node_modules(name: str) -> bool:
        return name == "node_modules"

    trie = PathTrie(tmp_path, ignore_node_modules, limit=100)
    paths = trie.get_paths()

    assert PurePath("node_modules/package") not in paths
    assert PurePath("node_modules/package/file.js") not in paths
