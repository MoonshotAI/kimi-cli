"""Tests for the glob tool."""

from __future__ import annotations

import platform

import pytest
from kosong.tooling import ToolError, ToolOk

from kaos.path import KaosPath
from kimi_cli.tools.file.glob import MAX_MATCHES, Glob, Params


@pytest.fixture
async def test_files(temp_work_dir: KaosPath):
    """Create test files for glob testing."""
    # Create a directory structure
    await (temp_work_dir / "src" / "main").mkdir(parents=True)
    await (temp_work_dir / "src" / "test").mkdir(parents=True)
    await (temp_work_dir / "docs").mkdir()

    # Create test files
    await (temp_work_dir / "README.md").write_text("# README")
    await (temp_work_dir / "setup.py").write_text("setup")
    await (temp_work_dir / "src" / "main.py").write_text("main")
    await (temp_work_dir / "src" / "utils.py").write_text("utils")
    await (temp_work_dir / "src" / "main" / "app.py").write_text("app")
    await (temp_work_dir / "src" / "main" / "config.py").write_text("config")
    await (temp_work_dir / "src" / "test" / "test_app.py").write_text("test app")
    await (temp_work_dir / "src" / "test" / "test_config.py").write_text("test config")
    await (temp_work_dir / "docs" / "guide.md").write_text("guide")
    await (temp_work_dir / "docs" / "api.md").write_text("api")

    return temp_work_dir


@pytest.mark.asyncio
async def test_glob_simple_pattern(glob_tool: Glob, test_files: KaosPath):
    """Test simple glob pattern matching."""
    result = await glob_tool(Params(pattern="*.py", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "setup.py" in result.output
    assert "Found 1 matches" in result.message


@pytest.mark.asyncio
async def test_glob_multiple_matches(glob_tool: Glob, test_files: KaosPath):
    """Test glob pattern with multiple matches."""
    result = await glob_tool(Params(pattern="*.md", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "README.md" in result.output
    assert "Found 1 matches" in result.message


@pytest.mark.asyncio
async def test_glob_recursive_pattern_prohibited(glob_tool: Glob, test_files: KaosPath):
    """Test that recursive glob pattern starting with **/ is prohibited."""
    result = await glob_tool(Params(pattern="**/*.py", directory=str(test_files)))

    assert isinstance(result, ToolError)
    assert "starts with '**' which is not allowed" in result.message
    assert "Unsafe pattern" in result.brief


@pytest.mark.asyncio
async def test_glob_safe_recursive_pattern(glob_tool: Glob, test_files: KaosPath):
    """Test safe recursive glob pattern that doesn't start with **/."""
    result = await glob_tool(Params(pattern="src/**/*.py", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    output = result.output.replace("\\", "/")  # Normalize for Windows paths
    assert "src/main.py" in output
    assert "src/utils.py" in output
    assert "src/main/app.py" in output
    assert "src/main/config.py" in output
    assert "src/test/test_app.py" in output
    assert "src/test/test_config.py" in output
    assert "Found 6 matches" in result.message


@pytest.mark.asyncio
async def test_glob_specific_directory(glob_tool: Glob, test_files: KaosPath):
    """Test glob pattern in specific directory."""
    src_dir = str(test_files / "src")
    result = await glob_tool(Params(pattern="*.py", directory=src_dir))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "main.py" in result.output
    assert "utils.py" in result.output
    assert "Found 2 matches" in result.message


@pytest.mark.asyncio
async def test_glob_recursive_in_subdirectory(glob_tool: Glob, test_files: KaosPath):
    """Test recursive glob in subdirectory."""
    src_dir = str(test_files / "src")
    result = await glob_tool(Params(pattern="main/**/*.py", directory=src_dir))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    output = result.output.replace("\\", "/")  # Normalize for Windows paths
    assert "main/app.py" in output
    assert "main/config.py" in output
    assert "Found 2 matches" in result.message


@pytest.mark.asyncio
async def test_glob_test_files(glob_tool: Glob, test_files: KaosPath):
    """Test glob pattern for test files."""
    result = await glob_tool(Params(pattern="src/**/*test*.py", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    output = result.output.replace("\\", "/")  # Normalize for Windows paths
    assert "src/test/test_app.py" in output
    assert "src/test/test_config.py" in output
    assert "Found 2 matches" in result.message


@pytest.mark.asyncio
async def test_glob_no_matches(glob_tool: Glob, test_files: KaosPath):
    """Test glob pattern with no matches."""
    result = await glob_tool(Params(pattern="*.xyz", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert result.output == ""
    assert "No matches found" in result.message


@pytest.mark.asyncio
async def test_glob_exclude_directories(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test glob with include_dirs=False."""
    # Create both files and directories
    await (temp_work_dir / "test_file.txt").write_text("content")
    await (temp_work_dir / "test_dir").mkdir()

    result = await glob_tool(
        Params(pattern="test_*", directory=str(temp_work_dir), include_dirs=False)
    )

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "test_file.txt" in result.output
    assert "test_dir" not in result.output
    assert "Found 1 matches" in result.message


@pytest.mark.asyncio
async def test_glob_with_relative_path(glob_tool: Glob):
    """Test glob with relative path (should fail)."""
    result = await glob_tool(Params(pattern="*.py", directory="relative/path"))

    assert isinstance(result, ToolError)
    assert "not an absolute path" in result.message


@pytest.mark.asyncio
async def test_glob_outside_work_directory(glob_tool: Glob):
    """Test glob outside working directory (should fail)."""
    dir = "/tmp/outside" if platform.system() != "Windows" else "C:/tmp/outside"
    result = await glob_tool(Params(pattern="*.py", directory=dir))

    assert isinstance(result, ToolError)
    assert "outside the working directory" in result.message


@pytest.mark.asyncio
async def test_glob_nonexistent_directory(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test glob in nonexistent directory."""
    nonexistent_dir = str(temp_work_dir / "nonexistent")
    result = await glob_tool(Params(pattern="*.py", directory=nonexistent_dir))

    assert isinstance(result, ToolError)
    assert "does not exist" in result.message


@pytest.mark.asyncio
async def test_glob_not_a_directory(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test glob on a file instead of directory."""
    test_file = temp_work_dir / "test.txt"
    await test_file.write_text("content")

    result = await glob_tool(Params(pattern="*.py", directory=str(test_file)))

    assert isinstance(result, ToolError)
    assert "is not a directory" in result.message


@pytest.mark.asyncio
async def test_glob_single_character_wildcard(glob_tool: Glob, test_files: KaosPath):
    """Test single character wildcard."""
    result = await glob_tool(Params(pattern="?.md", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert result.output == ""
    # Should match single character .md files


@pytest.mark.asyncio
async def test_glob_max_matches_limit(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test that glob respects the MAX_MATCHES limit."""
    # Create more than MAX_MATCHES files
    for i in range(MAX_MATCHES + 50):
        await (temp_work_dir / f"file_{i}.txt").write_text(f"content {i}")
    result = await glob_tool(Params(pattern="*.txt", directory=str(temp_work_dir)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    # Should only return MAX_MATCHES results
    output_lines = [line for line in result.output.split("\n") if line.strip()]
    assert len(output_lines) == MAX_MATCHES
    # Should contain warning message
    assert f"Only the first {MAX_MATCHES} matches are returned" in result.message


@pytest.mark.asyncio
async def test_glob_enhanced_double_star_validation(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test enhanced ** pattern validation with directory listing."""
    # Create some top-level files and directories for listing
    await (temp_work_dir / "file1.txt").write_text("content1")
    await (temp_work_dir / "file2.py").write_text("content2")
    await (temp_work_dir / "src").mkdir()
    await (temp_work_dir / "docs").mkdir()

    result = await glob_tool(Params(pattern="**/*.txt", directory=str(temp_work_dir)))

    assert isinstance(result, ToolError)
    assert "starts with '**' which is not allowed" in result.message
    assert "Use more specific patterns instead" in result.message
    # Should include directory listing
    assert isinstance(result.output, str)
    assert "file1.txt" in result.output
    assert "file2.py" in result.output
    assert "src" in result.output
    assert "docs" in result.output


@pytest.mark.asyncio
async def test_glob_exactly_max_matches(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test behavior when exactly MAX_MATCHES files are found."""
    # Create exactly MAX_MATCHES files
    for i in range(MAX_MATCHES):
        await (temp_work_dir / f"test_{i}.py").write_text(f"code {i}")
    result = await glob_tool(Params(pattern="*.py", directory=str(temp_work_dir)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    output_lines = [line for line in result.output.split("\n") if line.strip()]
    assert len(output_lines) == MAX_MATCHES
    # Should NOT contain warning message since we have exactly MAX_MATCHES
    assert "Only the first" not in result.message
    assert f"Found {MAX_MATCHES} matches" in result.message


@pytest.mark.asyncio
async def test_glob_character_class(glob_tool: Glob, temp_work_dir: KaosPath):
    """Test character class pattern."""
    await (temp_work_dir / "file1.py").write_text("content1")
    await (temp_work_dir / "file2.py").write_text("content2")
    await (temp_work_dir / "file3.txt").write_text("content3")
    result = await glob_tool(Params(pattern="file[1-2].py", directory=str(temp_work_dir)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "file1.py" in result.output
    assert "file2.py" in result.output
    assert "file3.txt" not in result.output


@pytest.mark.asyncio
async def test_glob_complex_pattern(glob_tool: Glob, test_files: KaosPath):
    """Test complex glob pattern combinations."""
    result = await glob_tool(Params(pattern="docs/**/main/*.py", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert result.output == ""
    # Should not match anything since there are no Python files in docs/main


@pytest.mark.asyncio
async def test_glob_wildcard_with_double_star_patterns(glob_tool: Glob, test_files: KaosPath):
    """Test various patterns with ** that are allowed."""
    # Test pattern with ** in the middle
    result = await glob_tool(Params(pattern="**/main/*.py", directory=str(test_files)))

    assert isinstance(result, ToolError)
    assert "starts with '**' which is not allowed" in result.message

    # Test pattern with ** not at the beginning
    result = await glob_tool(Params(pattern="src/**/test_*.py", directory=str(test_files)))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    output = result.output.replace("\\", "/")  # Normalize for Windows paths
    assert "src/test/test_app.py" in output
    assert "src/test/test_config.py" in output


@pytest.mark.asyncio
async def test_glob_pattern_edge_cases(glob_tool: Glob, test_files: KaosPath):
    """Test edge cases for pattern validation."""
    # Test pattern that has ** but not at the start
    result = await glob_tool(Params(pattern="src/**", directory=str(test_files)))
    assert isinstance(result, ToolOk)

    # Test pattern that starts with * but not **
    result = await glob_tool(Params(pattern="*.py", directory=str(test_files)))
    assert isinstance(result, ToolOk)

    # Test pattern that starts with **/
    result = await glob_tool(Params(pattern="**/*.txt", directory=str(test_files)))
    assert isinstance(result, ToolError)
    assert "starts with '**' which is not allowed" in result.message
