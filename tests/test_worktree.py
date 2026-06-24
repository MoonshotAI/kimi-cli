"""Tests for kimi_cli.worktree."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath

from kimi_cli.worktree import (
    WorktreeError,
    create_worktree,
    find_git_root,
    list_worktrees,
    remove_worktree,
)


@pytest.fixture(autouse=True)
def _ensure_local_kaos() -> None:
    token = set_current_kaos(LocalKaos())
    try:
        yield
    finally:
        reset_current_kaos(token)


def _kaos_path(p: Path) -> KaosPath:
    return KaosPath.unsafe_from_local_path(p)


async def _git_init(path: Path) -> None:
    """Initialize a git repo at *path*."""
    proc = await asyncio.create_subprocess_exec(
        "git",
        "init",
        cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    proc = await asyncio.create_subprocess_exec(
        "git",
        "config",
        "user.email",
        "test@test.com",
        cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    proc = await asyncio.create_subprocess_exec(
        "git",
        "config",
        "user.name",
        "Test",
        cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()


async def _git_commit(path: Path, message: str = "commit") -> None:
    """Stage all and commit."""
    proc = await asyncio.create_subprocess_exec(
        "git", "add", ".", cwd=path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    await proc.communicate()
    proc = await asyncio.create_subprocess_exec(
        "git",
        "commit",
        "-m",
        message,
        cwd=path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()


class TestFindGitRoot:
    @pytest.mark.asyncio
    async def test_returns_none_for_non_git_dir(self, tmp_path: Path) -> None:
        result = await find_git_root(_kaos_path(tmp_path))
        assert result is None

    @pytest.mark.asyncio
    async def test_finds_root(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        subdir = tmp_path / "a" / "b"
        subdir.mkdir(parents=True)
        result = await find_git_root(_kaos_path(subdir))
        assert result is not None
        assert str(result) == str(tmp_path)


class TestCreateWorktree:
    @pytest.mark.asyncio
    async def test_creates_worktree_detached(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        repo = _kaos_path(tmp_path)
        wt = await create_worktree(repo, name="feature-x")

        assert wt.name == "feature-x"
        assert (Path(str(wt)) / "file.txt").exists()

    @pytest.mark.asyncio
    async def test_creates_worktree_on_branch(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        # Create a branch from HEAD without checking it out in the main worktree.
        # This leaves the branch free for a worktree checkout.
        proc = await asyncio.create_subprocess_exec(
            "git", "branch", "feature-y",
            cwd=tmp_path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        repo = _kaos_path(tmp_path)
        wt = await create_worktree(repo, name="feature-y-wt", branch="feature-y")

        assert wt.name == "feature-y-wt"
        assert (Path(str(wt)) / "file.txt").exists()

    @pytest.mark.asyncio
    async def test_auto_generates_name(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        repo = _kaos_path(tmp_path)
        wt = await create_worktree(repo)

        assert wt.name.startswith("kimi-")

    @pytest.mark.asyncio
    async def test_raises_on_duplicate_name(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        repo = _kaos_path(tmp_path)
        await create_worktree(repo, name="dup")

        with pytest.raises(WorktreeError, match="already exists"):
            await create_worktree(repo, name="dup")

    @pytest.mark.asyncio
    async def test_raises_outside_git_repo(self, tmp_path: Path) -> None:
        with pytest.raises(WorktreeError):
            await create_worktree(_kaos_path(tmp_path), name="x")


class TestRemoveWorktree:
    @pytest.mark.asyncio
    async def test_removes_worktree(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        repo = _kaos_path(tmp_path)
        wt = await create_worktree(repo, name="to-remove")
        wt_path = Path(str(wt))
        assert wt_path.exists()

        await remove_worktree(repo, wt)
        assert not wt_path.exists()

    @pytest.mark.asyncio
    async def test_noop_for_missing_path(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        repo = _kaos_path(tmp_path)
        missing = _kaos_path(tmp_path / ".kimi" / "worktrees" / "ghost")
        # Should not raise
        await remove_worktree(repo, missing)


class TestListWorktrees:
    @pytest.mark.asyncio
    async def test_lists_worktrees(self, tmp_path: Path) -> None:
        await _git_init(tmp_path)
        (tmp_path / "file.txt").write_text("hello")
        await _git_commit(tmp_path, "initial")

        repo = _kaos_path(tmp_path)
        wt1 = await create_worktree(repo, name="wt1")
        wt2 = await create_worktree(repo, name="wt2")

        wts = await list_worktrees(repo)
        paths = {w["path"] for w in wts}
        assert str(wt1) in paths
        assert str(wt2) in paths

    @pytest.mark.asyncio
    async def test_empty_for_non_git(self, tmp_path: Path) -> None:
        wts = await list_worktrees(_kaos_path(tmp_path))
        assert wts == []
