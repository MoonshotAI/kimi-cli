"""Test symlink security in path validation and file operation tools."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from kaos.path import KaosPath
from kimi_cli.tools.file.glob import Glob, Params as GlobParams
from kimi_cli.tools.file.write import Params as WriteFileParams, WriteFile
from kimi_cli.utils.path import is_within_directory
from kosong.tooling import ToolError

# Skip symlink tests on Windows without proper permissions
_symlink_available = True
try:
    with tempfile.TemporaryDirectory() as tmpdir:
        test_link = Path(tmpdir) / "test_symlink"
        test_target = Path(tmpdir) / "test_target"
        test_target.touch()
        test_link.symlink_to(test_target)
except OSError:
    _symlink_available = False

requires_symlink = pytest.mark.skipif(
    not _symlink_available,
    reason="Symlinks not available (Windows without Developer Mode or elevated permissions)",
)


@requires_symlink
@pytest.mark.asyncio
class TestIsWithinDirectory:
    """Unit tests for is_within_directory function."""

    async def test_blocks_symlink_escape(self, temp_work_dir: KaosPath):
        """Test that symlinks cannot escape the work directory."""
        work_dir = Path(str(temp_work_dir))

        # Create a sensitive file outside work dir
        secret_file = work_dir.parent / "secret.txt"
        secret_file.write_text("secret content")

        # Create a malicious symlink inside work dir pointing outside
        malicious_link = work_dir / "link_to_secret"
        malicious_link.symlink_to(secret_file)

        link_kaos = KaosPath.unsafe_from_local_path(malicious_link)

        result = is_within_directory(link_kaos, temp_work_dir)
        assert result is False, "Symlink outside work directory should be blocked"

    async def test_allows_valid_symlinks(self, temp_work_dir: KaosPath):
        """Test that valid symlinks within work directory are allowed."""
        work_dir = Path(str(temp_work_dir))

        target_file = work_dir / "target.txt"
        target_file.write_text("content")

        valid_link = work_dir / "valid_link"
        valid_link.symlink_to(target_file)

        link_kaos = KaosPath.unsafe_from_local_path(valid_link)

        result = is_within_directory(link_kaos, temp_work_dir)
        assert result is True, "Valid symlink within work directory should be allowed"

    async def test_blocks_nested_symlinks(self, temp_work_dir: KaosPath):
        """Test that nested symlinks cannot escape the work directory."""
        work_dir = Path(str(temp_work_dir))

        intermediate = work_dir / "intermediate"
        intermediate.mkdir()

        outside_dir = work_dir.parent / "nested_outside"
        outside_dir.mkdir(exist_ok=True)

        malicious_link = intermediate / "escape"
        malicious_link.symlink_to(outside_dir)

        escape_kaos = KaosPath.unsafe_from_local_path(malicious_link)

        result = is_within_directory(escape_kaos, temp_work_dir)
        assert result is False, "Symlink chain should not allow directory escape"

    async def test_broken_symlinks(self, temp_work_dir: KaosPath):
        """Test behavior with broken symlinks."""
        work_dir = Path(str(temp_work_dir))

        # Broken symlink pointing outside work dir
        broken_link_outside = work_dir / "broken_outside"
        broken_link_outside.symlink_to(work_dir.parent / "nonexistent")

        # Broken symlink pointing inside work dir
        broken_link_inside = work_dir / "broken_inside"
        broken_link_inside.symlink_to(work_dir / "nonexistent_target")

        broken_outside_kaos = KaosPath.unsafe_from_local_path(broken_link_outside)
        broken_inside_kaos = KaosPath.unsafe_from_local_path(broken_link_inside)

        result_outside = is_within_directory(broken_outside_kaos, temp_work_dir)
        assert result_outside is False, "Broken symlink pointing outside should be blocked"

        result_inside = is_within_directory(broken_inside_kaos, temp_work_dir)
        assert result_inside is True, "Broken symlink pointing inside should be allowed"

    async def test_symlink_in_parent(self, temp_work_dir: KaosPath):
        """Test symlinks in parent directories."""
        work_dir = Path(str(temp_work_dir))

        # Create a symlink to work directory with unique name
        symlink_work = work_dir.parent / f"symlink_work_{work_dir.name}"
        if symlink_work.exists() or symlink_work.is_symlink():
            symlink_work.unlink()
        symlink_work.symlink_to(work_dir)

        # Create file under the real work directory
        test_file = work_dir / "test.txt"
        test_file.write_text("content")

        work_via_symlink = KaosPath.unsafe_from_local_path(symlink_work)
        file_via_symlink = KaosPath.unsafe_from_local_path(symlink_work / "test.txt")

        result = is_within_directory(file_via_symlink, work_via_symlink)
        assert result is True, "File within symlinked work directory should be allowed"

    async def test_edge_cases(self, temp_work_dir: KaosPath):
        """Test edge cases for path validation."""
        work_dir = Path(str(temp_work_dir))

        # Same directory
        assert is_within_directory(temp_work_dir, temp_work_dir) is True

        # Subdirectory
        subdir = work_dir / "subdir"
        subdir.mkdir()
        subdir_kaos = KaosPath.unsafe_from_local_path(subdir)
        assert is_within_directory(subdir_kaos, temp_work_dir) is True

        # Relative path components
        complex_path = work_dir / "a" / ".." / "b" / "./c"
        complex_kaos = KaosPath.unsafe_from_local_path(complex_path)
        assert is_within_directory(complex_kaos, temp_work_dir) is True

    async def test_handles_resolve_errors(self):
        """Test strict handling when resolve() fails."""
        with patch("pathlib.Path.resolve") as mock_resolve:
            mock_resolve.side_effect = OSError("Permission denied")

            work_kaos = KaosPath.unsafe_from_local_path(Path("/work"))
            test_kaos = KaosPath.unsafe_from_local_path(Path("/work/file"))

            # Strict sandboxing: deny access if resolution fails
            result = is_within_directory(test_kaos, work_kaos)
            assert result is False, "Should deny access when resolve fails (strict sandboxing)"


@requires_symlink
@pytest.mark.asyncio
class TestWriteFileSymlinkSecurity:
    """Symlink security tests for WriteFile tool."""

    async def test_blocks_symlink_escape(
        self, write_file_tool: WriteFile, temp_work_dir: KaosPath
    ):
        """WriteFile should reject writes that escape via symlink."""
        work_dir = Path(str(temp_work_dir))

        secret_file = work_dir.parent / "secret.txt"
        secret_file.write_text("original secret")

        malicious_link = work_dir / "secret.txt"
        malicious_link.symlink_to(secret_file)

        result = await write_file_tool(
            WriteFileParams(path=str(malicious_link), content="compromised", mode="overwrite")
        )

        assert isinstance(result, ToolError)
        assert "outside" in result.message.lower()
        assert secret_file.read_text() == "original secret"

    async def test_allows_internal_symlink(
        self, write_file_tool: WriteFile, temp_work_dir: KaosPath
    ):
        """WriteFile should allow symlinks that stay within work directory."""
        work_dir = Path(str(temp_work_dir))

        target_file = work_dir / "target.txt"
        target_file.write_text("original")
        valid_link = work_dir / "link.txt"
        valid_link.symlink_to(target_file)

        result = await write_file_tool(
            WriteFileParams(path=str(valid_link), content="modified", mode="overwrite")
        )

        assert not isinstance(result, ToolError)
        assert target_file.read_text() == "modified"


@requires_symlink
@pytest.mark.asyncio
class TestGlobSymlinkSecurity:
    """Symlink security tests for Glob tool."""

    async def test_blocks_directory_symlink_escape(
        self, glob_tool: Glob, temp_work_dir: KaosPath
    ):
        """Glob should reject directory arguments that escape via symlink."""
        work_dir = Path(str(temp_work_dir))

        outside_dir = work_dir.parent / "glob_outside"
        outside_dir.mkdir(exist_ok=True)
        (outside_dir / "secret.txt").write_text("secret")

        symlink_dir = work_dir / "symlink_outside"
        symlink_dir.symlink_to(outside_dir)

        result = await glob_tool(GlobParams(pattern="*", directory=str(symlink_dir)))

        assert isinstance(result, ToolError)
        assert "outside" in result.message.lower()

    async def test_allows_internal_symlinks(self, glob_tool: Glob, temp_work_dir: KaosPath):
        """Glob should allow symlinks that remain inside work directory."""
        work_dir = Path(str(temp_work_dir))

        (work_dir / "file1.txt").write_text("content1")
        (work_dir / "file2.txt").write_text("content2")
        (work_dir / "symlink.txt").symlink_to(work_dir / "file1.txt")

        result = await glob_tool(GlobParams(pattern="*.txt"))

        assert not isinstance(result, ToolError)
        output_str = result.output if isinstance(result.output, str) else str(result.output)
        assert "file1.txt" in output_str
        assert "file2.txt" in output_str
