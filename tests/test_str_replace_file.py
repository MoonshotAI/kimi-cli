"""Tests for the str_replace_file tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from kaos.path import KaosPath

from kimi_cli.tools.file.replace import Edit, Params, StrReplaceFile
from kimi_cli.wire.display import DiffDisplayBlock


@pytest.mark.asyncio
async def test_replace_single_occurrence(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing a single occurrence."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! This is a test."
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="world", new="universe"))
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    diff_block = next(block for block in result.display if block.type == "diff")
    assert isinstance(diff_block, DiffDisplayBlock)
    assert diff_block.path == str(file_path)
    assert diff_block.old_text == original_content
    assert diff_block.new_text == "Hello universe! This is a test."
    assert await file_path.read_text() == "Hello universe! This is a test."


@pytest.mark.asyncio
async def test_replace_all_occurrences(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing all occurrences."""
    file_path = temp_work_dir / "test.txt"
    original_content = "apple banana apple cherry apple"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=Edit(old="apple", new="fruit", replace_all=True),
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "fruit banana fruit cherry fruit"


@pytest.mark.asyncio
async def test_replace_multiple_edits(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test applying multiple edits."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! Goodbye world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=[
                Edit(old="Hello", new="Hi"),
                Edit(old="Goodbye", new="See you"),
            ],
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Hi world! See you world!"


@pytest.mark.asyncio
async def test_replace_multiline_content(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing multi-line content."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Line 1\nLine 2\nLine 3\n"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=Edit(old="Line 2\nLine 3", new="Modified line 2\nModified line 3"),
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Line 1\nModified line 2\nModified line 3\n"


@pytest.mark.asyncio
async def test_replace_unicode_content(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing unicode content."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello 世界! café"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="世界", new="地球"))
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Hello 地球! café"


@pytest.mark.asyncio
async def test_replace_no_match(str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath):
    """Test replacing when the old string is not found."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="notfound", new="replacement"))
    )

    assert result.is_error
    assert "No replacements were made" in result.message
    assert await file_path.read_text() == original_content  # Content unchanged


@pytest.mark.asyncio
async def test_replace_with_relative_path(str_replace_file_tool: StrReplaceFile):
    """Test replacing with a relative path (should fail)."""
    result = await str_replace_file_tool(
        Params(path="relative/path/file.txt", edit=Edit(old="old", new="new"))
    )

    assert result.is_error
    assert "not an absolute path" in result.message


@pytest.mark.asyncio
async def test_replace_outside_work_directory(
    str_replace_file_tool: StrReplaceFile, outside_file: Path
):
    """Test replacing outside the working directory (should fail)."""
    result = await str_replace_file_tool(
        Params(path=str(outside_file), edit=Edit(old="old", new="new"))
    )

    assert result.is_error
    assert "outside the working directory" in result.message


@pytest.mark.asyncio
async def test_replace_outside_work_directory_with_prefix(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Paths sharing the work dir prefix but outside should be blocked."""
    base = Path(str(temp_work_dir))
    sneaky_dir = base.parent / f"{base.name}-sneaky"
    sneaky_dir.mkdir(parents=True, exist_ok=True)
    sneaky_file = sneaky_dir / "test.txt"
    sneaky_file.write_text("content", encoding="utf-8")

    result = await str_replace_file_tool(
        Params(path=str(sneaky_file), edit=Edit(old="content", new="new"))
    )

    assert result.is_error
    assert "outside the working directory" in result.message


@pytest.mark.asyncio
async def test_replace_nonexistent_file(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing in a non-existent file."""
    file_path = temp_work_dir / "nonexistent.txt"

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="old", new="new"))
    )

    assert result.is_error
    assert "does not exist" in result.message


@pytest.mark.asyncio
async def test_replace_directory_instead_of_file(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing in a directory instead of a file."""
    dir_path = temp_work_dir / "directory"
    await dir_path.mkdir()

    result = await str_replace_file_tool(
        Params(path=str(dir_path), edit=Edit(old="old", new="new"))
    )

    assert result.is_error
    assert "is not a file" in result.message


@pytest.mark.asyncio
async def test_replace_mixed_multiple_edits(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test multiple edits with different replace_all settings."""
    file_path = temp_work_dir / "test.txt"
    original_content = "apple apple banana apple cherry"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=[
                Edit(old="apple", new="fruit", replace_all=False),  # Only first occurrence
                Edit(
                    old="banana", new="tasty", replace_all=True
                ),  # All occurrences (though only one)
            ],
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "fruit apple tasty apple cherry"


@pytest.mark.asyncio
async def test_replace_empty_strings(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing with empty strings."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="world", new=""))
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Hello !"
