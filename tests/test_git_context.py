"""Tests for kimi_cli.subagents.git_context."""

from __future__ import annotations

import asyncio
from collections.abc import Generator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath

from kimi_cli.subagents.git_context import (
    _parse_project_name,
    _run_git,
    _sanitize_remote_url,
    collect_git_context,
)


@pytest.fixture(autouse=True)
def _ensure_local_kaos() -> Generator[None]:
    """Ensure LocalKaos is set for all tests in this module."""
    token = set_current_kaos(LocalKaos())
    try:
        yield
    finally:
        reset_current_kaos(token)


def _kaos_path(p: Path) -> KaosPath:
    return KaosPath.unsafe_from_local_path(p)


class TestParseProjectName:
    def test_ssh_format(self) -> None:
        assert _parse_project_name("git@github.com:user/repo.git") == "user/repo"

    def test_ssh_format_no_dot_git(self) -> None:
        assert _parse_project_name("git@github.com:user/repo") == "user/repo"

    def test_https_format(self) -> None:
        assert _parse_project_name("https://github.com/user/repo.git") == "user/repo"

    def test_https_format_no_dot_git(self) -> None:
        assert _parse_project_name("https://github.com/user/repo") == "user/repo"

    def test_ssh_gitlab(self) -> None:
        assert _parse_project_name("git@gitlab.com:org/project.git") == "org/project"

    def test_invalid_url(self) -> None:
        assert _parse_project_name("not-a-url") is None

    def test_empty_string(self) -> None:
        assert _parse_project_name("") is None


class TestSanitizeRemoteUrl:
    def test_github_ssh(self) -> None:
        assert (
            _sanitize_remote_url("git@github.com:user/repo.git") == "git@github.com:user/repo.git"
        )

    def test_github_https(self) -> None:
        assert (
            _sanitize_remote_url("https://github.com/user/repo.git")
            == "https://github.com/user/repo.git"
        )

    def test_github_https_strips_token(self) -> None:
        assert (
            _sanitize_remote_url("https://ghp_abc123@github.com/user/repo.git")
            == "https://github.com/user/repo.git"
        )

    def test_github_https_strips_user_pass(self) -> None:
        assert (
            _sanitize_remote_url("https://user:pass@github.com/user/repo.git")
            == "https://github.com/user/repo.git"
        )

    def test_gitlab_ssh(self) -> None:
        assert (
            _sanitize_remote_url("git@gitlab.com:org/project.git")
            == "git@gitlab.com:org/project.git"
        )

    def test_gitlab_https(self) -> None:
        assert (
            _sanitize_remote_url("https://gitlab.com/org/project.git")
            == "https://gitlab.com/org/project.git"
        )

    def test_gitee_ssh(self) -> None:
        assert (
            _sanitize_remote_url("git@gitee.com:org/project.git") == "git@gitee.com:org/project.git"
        )

    def test_gitee_https_strips_token(self) -> None:
        assert (
            _sanitize_remote_url("https://token@gitee.com/org/project.git")
            == "https://gitee.com/org/project.git"
        )

    def test_bitbucket_ssh(self) -> None:
        assert (
            _sanitize_remote_url("git@bitbucket.org:team/repo.git")
            == "git@bitbucket.org:team/repo.git"
        )

    def test_self_hosted_returns_none(self) -> None:
        assert _sanitize_remote_url("git@git.internal.corp.com:team/repo.git") is None

    def test_self_hosted_https_returns_none(self) -> None:
        assert _sanitize_remote_url("https://git.internal.corp.com/team/repo.git") is None

    def test_lookalike_host_returns_none(self) -> None:
        assert _sanitize_remote_url("https://github.com.evil/repo.git") is None

    def test_lookalike_host_subdomain_returns_none(self) -> None:
        assert _sanitize_remote_url("https://github.com.internal.corp/team/repo.git") is None

    def test_fake_port_returns_none(self) -> None:
        assert _sanitize_remote_url("https://github.com:443.evil/user/repo.git") is None

    def test_non_numeric_port_returns_none(self) -> None:
        assert _sanitize_remote_url("https://github.com:abc/user/repo.git") is None

    def test_valid_port_allowed(self) -> None:
        assert (
            _sanitize_remote_url("https://github.com:443/user/repo.git")
            == "https://github.com:443/user/repo.git"
        )

    def test_empty_returns_none(self) -> None:
        assert _sanitize_remote_url("") is None


class TestRunGit:
    @pytest.mark.asyncio
    async def test_returns_none_for_nonexistent_dir(self, tmp_path: Path) -> None:
        bad_dir = tmp_path / "nonexistent"
        result = await _run_git(["status"], str(bad_dir))
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_non_git_dir(self, tmp_path: Path) -> None:
        result = await _run_git(["status"], str(tmp_path))
        assert result is None

    @pytest.mark.asyncio
    async def test_timeout_returns_none(self, tmp_path: Path) -> None:
        """Simulates a timeout by using an extremely short timeout."""
        result = await _run_git(["version"], str(tmp_path), timeout=0.0001)
        # Result could be None (timed out) or a string (too fast to timeout)
        # Either way, it should not raise
        assert result is None or isinstance(result, str)


class TestCollectGitContext:
    @pytest.mark.asyncio
    async def test_non_git_directory_returns_empty(self, tmp_path: Path) -> None:
        result = await collect_git_context(_kaos_path(tmp_path))
        assert result == ""

    @pytest.mark.asyncio
    async def test_git_repo_returns_context(self, tmp_path: Path) -> None:
        """Test with a real temporary git repo."""
        proc = await asyncio.create_subprocess_exec(
            "git",
            "init",
            cwd=tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        await (
            await asyncio.create_subprocess_exec(
                "git",
                "config",
                "user.email",
                "test@test.com",
                cwd=tmp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        ).communicate()
        await (
            await asyncio.create_subprocess_exec(
                "git",
                "config",
                "user.name",
                "Test",
                cwd=tmp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        ).communicate()

        test_file = tmp_path / "test.txt"
        test_file.write_text("hello")
        await (
            await asyncio.create_subprocess_exec(
                "git",
                "add",
                ".",
                cwd=tmp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        ).communicate()
        await (
            await asyncio.create_subprocess_exec(
                "git",
                "commit",
                "-m",
                "initial commit",
                cwd=tmp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        ).communicate()

        result = await collect_git_context(_kaos_path(tmp_path))
        assert "<git-context>" in result
        assert "</git-context>" in result
        assert f"Working directory: {tmp_path}" in result
        assert "Recent commits:" in result
        assert "initial commit" in result

    @pytest.mark.asyncio
    async def test_dirty_files_shown(self, tmp_path: Path) -> None:
        """Test that dirty files are reported."""
        proc = await asyncio.create_subprocess_exec(
            "git",
            "init",
            cwd=tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        (tmp_path / "dirty.txt").write_text("dirty")

        result = await collect_git_context(_kaos_path(tmp_path))
        assert "Dirty files" in result
        assert "dirty.txt" in result

    @pytest.mark.asyncio
    async def test_all_commands_fail_returns_empty(self, tmp_path: Path) -> None:
        """If every git command fails, return empty string."""
        with patch(
            "kimi_cli.subagents.git_context._run_git",
            new_callable=AsyncMock,
            return_value=None,
        ):
            result = await collect_git_context(_kaos_path(tmp_path / "fake"))
            assert result == ""

    @pytest.mark.asyncio
    async def test_remote_url_with_project_name(self, tmp_path: Path) -> None:
        """Test that remote origin and project name are extracted."""
        proc = await asyncio.create_subprocess_exec(
            "git",
            "init",
            cwd=tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        await (
            await asyncio.create_subprocess_exec(
                "git",
                "remote",
                "add",
                "origin",
                "https://github.com/testorg/testrepo.git",
                cwd=tmp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        ).communicate()

        result = await collect_git_context(_kaos_path(tmp_path))
        assert "Remote: https://github.com/testorg/testrepo.git" in result
        assert "Project: testorg/testrepo" in result

    @pytest.mark.asyncio
    async def test_self_hosted_remote_hides_url(self, tmp_path: Path) -> None:
        """Self-hosted remote: Remote line hidden, but Project still extracted."""
        proc = await asyncio.create_subprocess_exec(
            "git",
            "init",
            cwd=tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        await (
            await asyncio.create_subprocess_exec(
                "git",
                "remote",
                "add",
                "origin",
                "https://git.internal.corp.com/testorg/testrepo.git",
                cwd=tmp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        ).communicate()

        result = await collect_git_context(_kaos_path(tmp_path))
        assert "Remote:" not in result
        assert "Project: testorg/testrepo" in result

    @pytest.mark.asyncio
    async def test_dirty_files_capped(self, tmp_path: Path) -> None:
        """Test that dirty files are capped at 20."""
        proc = await asyncio.create_subprocess_exec(
            "git",
            "init",
            cwd=tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        for i in range(25):
            (tmp_path / f"file_{i:02d}.txt").write_text(f"content {i}")

        result = await collect_git_context(_kaos_path(tmp_path))
        assert "Dirty files (25):" in result
        assert "... and 5 more" in result
