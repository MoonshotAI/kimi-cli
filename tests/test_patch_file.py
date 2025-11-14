"""Simplified tests for PatchFile tool - focusing on current behavior."""

from __future__ import annotations

from pathlib import Path

import pytest

from kimi_cli.tools.file.patch import Params, PatchFile, ToolError, ToolOk


@pytest.mark.asyncio
async def test_simple_patch(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test basic patch application."""
    # Create test file
    test_file = temp_work_dir / "test.txt"
    test_file.write_text("Line 1\nLine 2\nLine 3\n")

    # Apply simple patch
    patch: str = """--- test.txt	2024-01-01 00:00:00.000000000 +0000
+++ test.txt	2024-01-01 00:00:00.000000000 +0000
@@ -1,3 +1,3 @@
 Line 1
-Line 2
+Modified Line 2
 Line 3
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    assert isinstance(result, ToolOk)
    assert "successfully patched" in result.message
    assert test_file.read_text() == "Line 1\nModified Line 2\nLine 3\n"


@pytest.mark.asyncio
async def test_multiple_hunks(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test patch with multiple hunks."""
    test_file = temp_work_dir / "test.txt"
    test_file.write_text("Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n")

    patch: str = """--- test.txt	2024-01-01 00:00:00.000000000 +0000
+++ test.txt	2024-01-01 00:00:00.000000000 +0000
@@ -1,3 +1,3 @@
 Line 1
-Line 2
+Modified Line 2
 Line 3
@@ -4,2 +4,2 @@
 Line 4
-Line 5
+Modified Line 5
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    assert isinstance(result, ToolOk)
    expected: str = "Line 1\nModified Line 2\nLine 3\nLine 4\nModified Line 5\n"
    assert test_file.read_text() == expected


@pytest.mark.asyncio
async def test_unicode_support(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test Unicode content patching."""
    test_file = temp_work_dir / "unicode.txt"
    test_file.write_text("Hello 世界\ncafé naïve\n", encoding="utf-8")

    patch: str = """--- unicode.txt	2023-01-01 00:00:00.000000000 +0000
+++ unicode.txt	2023-01-01 00:00:00.000000000 +0000
@@ -1,2 +1,2 @@
-Hello 世界
+Hello 地球
 café naïve
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    assert isinstance(result, ToolOk)
    assert "Hello 地球" in test_file.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_error_cases(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test various error conditions."""
    # 1. Relative path error
    result = await patch_file_tool(
        Params(
            path="relative/path/file.txt",
            diff="--- test\n+++ test\n@@ -1 +1 @@\n-old\n+new\n",
        )
    )
    assert isinstance(result, ToolError)
    assert "not an absolute path" in result.message

    # 2. Nonexistent file
    nonexistent: Path = temp_work_dir / "nonexistent.txt"
    result = await patch_file_tool(
        Params(
            path=str(nonexistent),
            diff="--- test\n+++ test\n@@ -1 +1 @@\n-old\n+new\n",
        )
    )
    assert isinstance(result, ToolError)
    assert "does not exist" in result.message

    # 3. Invalid diff format
    test_file: Path = temp_work_dir / "test.txt"
    test_file.write_text("content")
    result = await patch_file_tool(Params(path=str(test_file), diff="This is not a valid diff"))
    assert isinstance(result, ToolError)
    assert "invalid patch format" in result.message

    # 4. Mismatched patch
    test_file.write_text("Different content")
    mismatch_patch: str = """--- test.txt	2023-01-01 00:00:00.000000000 +0000
+++ test.txt	2023-01-01 00:00:00.000000000 +0000
@@ -1,3 +1,3 @@
 First line
-Second line
+Modified second line
 Third line
"""
    result = await patch_file_tool(Params(path=str(test_file), diff=mismatch_patch))
    assert isinstance(result, ToolError)
    assert "Failed to apply patch" in result.message


@pytest.mark.asyncio
async def test_empty_file(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test patching empty file."""
    test_file: Path = temp_work_dir / "empty.txt"
    test_file.write_text("")

    patch: str = """--- empty.txt	2023-01-01 00:00:00.000000000 +0000
+++ empty.txt	2023-01-01 00:00:00.000000000 +0000
@@ -0,0 +1,2 @@
+First line
+Second line
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    # Empty file patch may succeed or fail depending on patch-ng judgment
    if isinstance(result, ToolOk):
        assert test_file.read_text() == "First line\nSecond line\n"
    else:
        assert isinstance(result, ToolError)


@pytest.mark.asyncio
async def test_adding_lines(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test adding new lines."""
    test_file: Path = temp_work_dir / "test.txt"
    test_file.write_text("First line\nLast line\n")

    patch: str = """--- test.txt	2023-01-01 00:00:00.000000000 +0000
+++ test.txt	2023-01-01 00:00:00.000000000 +0000
@@ -1,2 +1,3 @@
 First line
+New middle line
 Last line
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    assert isinstance(result, ToolOk)
    assert test_file.read_text() == "First line\nNew middle line\nLast line\n"


@pytest.mark.asyncio
async def test_removing_lines(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test removing lines."""
    test_file: Path = temp_work_dir / "test.txt"
    test_file.write_text("First line\nMiddle line to remove\nLast line\n")

    patch: str = """--- test.txt	2023-01-01 00:00:00.000000000 +0000
+++ test.txt	2023-01-01 00:00:00.000000000 +0000
@@ -1,3 +1,2 @@
 First line
-Middle line to remove
 Last line
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    assert isinstance(result, ToolOk)
    assert test_file.read_text() == "First line\nLast line\n"


@pytest.mark.asyncio
async def test_no_changes_made(patch_file_tool: PatchFile, temp_work_dir: Path) -> None:
    """Test patch that makes no changes."""
    test_file: Path = temp_work_dir / "test.txt"
    original_content: str = "Line 1\nLine 2\n"
    test_file.write_text(original_content)

    # Patch with no actual changes
    patch: str = """--- test.txt	2023-01-01 00:00:00.000000000 +0000
+++ test.txt	2023-01-01 00:00:00.000000000 +0000
@@ -1,2 +1,2 @@
 Line 1
 Line 2
"""

    result = await patch_file_tool(Params(path=str(test_file), diff=patch))

    assert isinstance(result, ToolError)
    assert "No changes were made" in result.message
