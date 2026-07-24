"""Tests for file_filter: git vs walk cross-validation and edge cases."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from kimi_cli.utils.file_filter import (
    is_ignored,
    list_files_git,
    list_files_walk,
)


def _init_git(root: Path) -> None:
    for cmd in (
        ["git", "init"],
        ["git", "config", "user.email", "t@t.com"],
        ["git", "config", "user.name", "T"],
        ["git", "add", "-A"],
        ["git", "commit", "-m", "init"],
    ):
        subprocess.run(cmd, cwd=root, capture_output=True, check=True)


# ---------------------------------------------------------------------------
# Cross-validation: git vs walk must agree on a clean working tree
# ---------------------------------------------------------------------------


class TestGitWalkParity:
    """On a clean git repo the two backends must return the same path set."""

    def test_flat_repo(self, tmp_path: Path) -> None:
        (tmp_path / "README.md").write_text("hi")
        (tmp_path / "main.py").write_text("print(1)")
        _init_git(tmp_path)

        git = set(list_files_git(tmp_path) or [])
        walk = set(list_files_walk(tmp_path))
        assert git == walk

    def test_nested_dirs(self, tmp_path: Path) -> None:
        (tmp_path / "src" / "pkg").mkdir(parents=True)
        (tmp_path / "src" / "pkg" / "mod.py").write_text("")
        (tmp_path / "src" / "app.py").write_text("")
        (tmp_path / "docs").mkdir()
        (tmp_path / "docs" / "guide.md").write_text("")
        _init_git(tmp_path)

        git = set(list_files_git(tmp_path) or [])
        walk = set(list_files_walk(tmp_path))
        assert git == walk

    def test_with_gitignore(self, tmp_path: Path) -> None:
        """Gitignored files excluded from both paths."""
        (tmp_path / "app.py").write_text("")
        (tmp_path / "debug.log").write_text("log")
        (tmp_path / ".gitignore").write_text("*.log\n")
        _init_git(tmp_path)

        git = set(list_files_git(tmp_path) or [])
        walk = set(list_files_walk(tmp_path))

        assert "debug.log" not in git
        # walk doesn't read .gitignore, so it may include debug.log.
        # The key invariant: git is a subset of walk for non-gitignored files.
        assert git <= walk | {"debug.log"}

    def test_scoped_search_parity(self, tmp_path: Path) -> None:
        (tmp_path / "src" / "core").mkdir(parents=True)
        (tmp_path / "src" / "core" / "engine.py").write_text("")
        (tmp_path / "src" / "util.py").write_text("")
        (tmp_path / "docs").mkdir()
        (tmp_path / "docs" / "api.md").write_text("")
        _init_git(tmp_path)

        git = set(list_files_git(tmp_path, "src") or [])
        walk = set(list_files_walk(tmp_path, "src"))
        assert git == walk

        # No docs contamination
        assert not any("docs" in p for p in git)


# ---------------------------------------------------------------------------
# Ignored directory filtering (tracked content must still be hidden)
# ---------------------------------------------------------------------------


class TestIgnoredDirFiltering:
    """Tracked ignored dirs must not leak into git results."""

    @pytest.mark.parametrize(
        "dirname", ["node_modules", "vendor", "__pycache__", ".vscode", "dist"]
    )
    def test_tracked_ignored_dir_filtered(self, tmp_path: Path, dirname: str) -> None:
        (tmp_path / "keep.py").write_text("")
        d = tmp_path / dirname
        d.mkdir()
        (d / "stuff.js").write_text("")
        _init_git(tmp_path)

        git = list_files_git(tmp_path) or []
        walk = list_files_walk(tmp_path)

        assert not any(dirname in p for p in git), f"{dirname} leaked via git"
        assert not any(dirname in p for p in walk), f"{dirname} leaked via walk"

    def test_nested_ignored_dir(self, tmp_path: Path) -> None:
        """Ignored dir deep inside tree must also be filtered."""
        (tmp_path / "src" / "lib" / "node_modules" / "pkg").mkdir(parents=True)
        (tmp_path / "src" / "lib" / "node_modules" / "pkg" / "index.js").write_text("")
        (tmp_path / "src" / "lib" / "real.py").write_text("")
        _init_git(tmp_path)

        git = list_files_git(tmp_path) or []
        assert "src/lib/real.py" in git
        assert not any("node_modules" in p for p in git)


# ---------------------------------------------------------------------------
# Deleted / renamed file handling
# ---------------------------------------------------------------------------


class TestDeletedFileHandling:
    """Stale index entries must not appear in results."""

    def test_deleted_file_excluded(self, tmp_path: Path) -> None:
        (tmp_path / "a.py").write_text("")
        (tmp_path / "b.py").write_text("")
        _init_git(tmp_path)

        os.remove(tmp_path / "a.py")

        git = list_files_git(tmp_path) or []
        assert "a.py" not in git
        assert "b.py" in git

    def test_renamed_file_old_excluded_new_included(self, tmp_path: Path) -> None:
        (tmp_path / "old.py").write_text("# old")
        _init_git(tmp_path)

        (tmp_path / "old.py").rename(tmp_path / "new.py")

        git = list_files_git(tmp_path) or []
        assert "old.py" not in git
        assert "new.py" in git

    def test_empty_dir_pruned_after_delete(self, tmp_path: Path) -> None:
        """Deleting the only file under a dir must also remove the dir entry."""
        (tmp_path / "solo").mkdir()
        (tmp_path / "solo" / "only.py").write_text("")
        (tmp_path / "keep.py").write_text("")
        _init_git(tmp_path)

        os.remove(tmp_path / "solo" / "only.py")
        os.rmdir(tmp_path / "solo")

        git = list_files_git(tmp_path) or []
        assert "solo/" not in git
        assert "solo/only.py" not in git
        assert "keep.py" in git

    def test_partial_delete_preserves_dir(self, tmp_path: Path) -> None:
        """Deleting one of two files keeps the dir entry."""
        (tmp_path / "pkg").mkdir()
        (tmp_path / "pkg" / "a.py").write_text("")
        (tmp_path / "pkg" / "b.py").write_text("")
        _init_git(tmp_path)

        os.remove(tmp_path / "pkg" / "a.py")

        git = list_files_git(tmp_path) or []
        assert "pkg/" in git
        assert "pkg/a.py" not in git
        assert "pkg/b.py" in git


# ---------------------------------------------------------------------------
# Untracked file discovery
# ---------------------------------------------------------------------------


class TestUntrackedFiles:
    """New untracked files (respecting .gitignore) must be discovered."""

    def test_untracked_file_included(self, tmp_path: Path) -> None:
        (tmp_path / "tracked.py").write_text("")
        _init_git(tmp_path)

        (tmp_path / "untracked.py").write_text("# new")

        git = list_files_git(tmp_path) or []
        assert "tracked.py" in git
        assert "untracked.py" in git

    def test_gitignored_untracked_excluded(self, tmp_path: Path) -> None:
        (tmp_path / "app.py").write_text("")
        (tmp_path / ".gitignore").write_text("*.log\n")
        _init_git(tmp_path)

        (tmp_path / "debug.log").write_text("noise")

        git = list_files_git(tmp_path) or []
        assert "debug.log" not in git

    def test_untracked_without_flag(self, tmp_path: Path) -> None:
        (tmp_path / "tracked.py").write_text("")
        _init_git(tmp_path)
        (tmp_path / "untracked.py").write_text("")

        git = list_files_git(tmp_path, include_untracked=False) or []
        assert "tracked.py" in git
        assert "untracked.py" not in git


# ---------------------------------------------------------------------------
# Path traversal prevention
# ---------------------------------------------------------------------------


class TestSpecialCharFilenames:
    """Filenames with tab, quotes, or backslash must be handled correctly."""

    def test_tab_in_filename(self, tmp_path: Path) -> None:
        p = tmp_path / "tab\there.py"
        p.write_text("")
        _init_git(tmp_path)

        git = list_files_git(tmp_path) or []
        assert "tab\there.py" in git

    def test_quote_in_filename(self, tmp_path: Path) -> None:
        p = tmp_path / 'quote"name.py'
        p.write_text("")
        _init_git(tmp_path)

        git = list_files_git(tmp_path) or []
        assert 'quote"name.py' in git

    def test_backslash_in_filename(self, tmp_path: Path) -> None:
        p = tmp_path / "back\\slash.py"
        p.write_text("")
        _init_git(tmp_path)

        git = list_files_git(tmp_path) or []
        assert "back\\slash.py" in git


class TestPathTraversal:
    """Scope containing ``..`` must be rejected."""

    def test_git_rejects_dotdot(self, tmp_path: Path) -> None:
        (tmp_path / "a.py").write_text("")
        _init_git(tmp_path)
        assert list_files_git(tmp_path, "..") is None

    def test_walk_rejects_dotdot(self, tmp_path: Path) -> None:
        (tmp_path / "a.py").write_text("")
        assert list_files_walk(tmp_path, "..") == []

    def test_nested_dotdot_rejected(self, tmp_path: Path) -> None:
        (tmp_path / "a.py").write_text("")
        _init_git(tmp_path)
        assert list_files_git(tmp_path, "src/../../etc") is None


# ---------------------------------------------------------------------------
# Dash-prefixed directory names (must not be parsed as git options)
# ---------------------------------------------------------------------------


class TestDashPrefixScope:
    """Directory names starting with ``-`` must not be misinterpreted as git options."""

    def test_git_scoped_dash_prefix(self, tmp_path: Path) -> None:
        d = tmp_path / "-docs"
        d.mkdir()
        (d / "guide.md").write_text("# guide")
        _init_git(tmp_path)

        result = list_files_git(tmp_path, "-docs")
        assert result is not None
        assert "-docs/guide.md" in result

    def test_git_deleted_with_dash_prefix(self, tmp_path: Path) -> None:
        d = tmp_path / "-data"
        d.mkdir()
        (d / "old.csv").write_text("a,b")
        _init_git(tmp_path)
        (d / "old.csv").unlink()

        result = list_files_git(tmp_path, "-data")
        assert result is not None
        assert not any("old.csv" in p for p in result)

    def test_git_untracked_with_dash_prefix(self, tmp_path: Path) -> None:
        d = tmp_path / "-src"
        d.mkdir()
        (d / "tracked.py").write_text("# tracked")
        _init_git(tmp_path)
        (d / "new.py").write_text("# new")

        result = list_files_git(tmp_path, "-src")
        assert result is not None
        assert "-src/new.py" in result


# ---------------------------------------------------------------------------
# is_ignored unit tests
# ---------------------------------------------------------------------------


class TestIsIgnored:
    @pytest.mark.parametrize(
        "name",
        ["node_modules", "__pycache__", ".git", ".DS_Store", "vendor", "dist", ".vscode"],
    )
    def test_ignored_names(self, name: str) -> None:
        assert is_ignored(name)

    @pytest.mark.parametrize(
        "name",
        ["foo_cache", "bar-cache", "pkg.egg-info", "lib.dist-info", "mod.pyc", "A.class", "f.swp"],
    )
    def test_ignored_patterns(self, name: str) -> None:
        assert is_ignored(name)

    @pytest.mark.parametrize(
        "name",
        ["src", "main.py", "README.md", "package.json", ".gitignore", "Makefile"],
    )
    def test_not_ignored(self, name: str) -> None:
        assert not is_ignored(name)

    def test_empty_is_ignored(self) -> None:
        assert is_ignored("")


# ---------------------------------------------------------------------------
# Fallback behaviour
# ---------------------------------------------------------------------------


class TestFallback:
    """list_files_git returns None for non-git dirs; walk always works."""

    def test_non_git_returns_none(self, tmp_path: Path) -> None:
        (tmp_path / "a.py").write_text("")
        assert list_files_git(tmp_path) is None

    def test_walk_works_without_git(self, tmp_path: Path) -> None:
        (tmp_path / "a.py").write_text("")
        result = list_files_walk(tmp_path)
        assert "a.py" in result
