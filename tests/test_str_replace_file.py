"""Tests for the str_replace_file tool."""

from pathlib import Path

import pytest
from kosong.tooling import ToolError, ToolOk

from kimi_cli.tools.file.read import Params as ReadParams, ReadFile
from kimi_cli.tools.file.replace import Edit, Params as ReplaceParams, StrReplaceFile


async def _mark_file_as_read(read_file_tool: ReadFile, path: Path) -> None:
    """Ensure the file is recorded as read before attempting modifications."""
    result = await read_file_tool(ReadParams(path=str(path)))
    assert isinstance(result, ToolOk)


@pytest.mark.asyncio
async def test_replace_single_occurrence(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test replacing a single occurrence."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! This is a test."
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(path=str(file_path), edit=Edit(old="world", new="universe"))
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "Hello universe! This is a test."


@pytest.mark.asyncio
async def test_replace_requires_read(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: Path
):
    """Ensure replace tool fails if the file was not read this session."""
    file_path = temp_work_dir / "require_read.txt"
    file_path.write_text("hello")

    result = await str_replace_file_tool(
        ReplaceParams(path=str(file_path), edit=Edit(old="hello", new="hi"))
    )

    assert isinstance(result, ToolError)
    assert "ReadFile" in result.message


@pytest.mark.asyncio
async def test_replace_all_occurrences(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test replacing all occurrences."""
    file_path = temp_work_dir / "test.txt"
    original_content = "apple banana apple cherry apple"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(
            path=str(file_path),
            edit=Edit(old="apple", new="fruit", replace_all=True),
        )
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "fruit banana fruit cherry fruit"


@pytest.mark.asyncio
async def test_replace_multiple_edits(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test applying multiple edits."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! Goodbye world!"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(
            path=str(file_path),
            edit=[
                Edit(old="Hello", new="Hi"),
                Edit(old="Goodbye", new="See you"),
            ],
        )
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "Hi world! See you world!"


@pytest.mark.asyncio
async def test_replace_multiline_content(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test replacing multi-line content."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Line 1\nLine 2\nLine 3\n"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(
            path=str(file_path),
            edit=Edit(old="Line 2\nLine 3", new="Modified line 2\nModified line 3"),
        )
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "Line 1\nModified line 2\nModified line 3\n"


@pytest.mark.asyncio
async def test_replace_unicode_content(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test replacing unicode content."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello 世界! café"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(path=str(file_path), edit=Edit(old="世界", new="地球"))
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "Hello 地球! café"


@pytest.mark.asyncio
async def test_replace_no_match(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test replacing when the old string is not found."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(path=str(file_path), edit=Edit(old="notfound", new="replacement"))
    )

    assert isinstance(result, ToolError)
    assert "No replacements were made" in result.message
    assert file_path.read_text() == original_content  # Content unchanged


@pytest.mark.asyncio
async def test_replace_with_relative_path(str_replace_file_tool: StrReplaceFile):
    """Test replacing with a relative path (should fail)."""
    result = await str_replace_file_tool(
        ReplaceParams(path="relative/path/file.txt", edit=Edit(old="old", new="new"))
    )

    assert isinstance(result, ToolError)
    assert "not an absolute path" in result.message


@pytest.mark.asyncio
async def test_replace_outside_work_directory(str_replace_file_tool: StrReplaceFile):
    """Test replacing outside the working directory (should fail)."""
    result = await str_replace_file_tool(
        ReplaceParams(path="/tmp/outside.txt", edit=Edit(old="old", new="new"))
    )

    assert isinstance(result, ToolError)
    assert "outside the working directory" in result.message


@pytest.mark.asyncio
async def test_replace_nonexistent_file(str_replace_file_tool: StrReplaceFile, temp_work_dir: Path):
    """Test replacing in a non-existent file."""
    file_path = temp_work_dir / "nonexistent.txt"

    result = await str_replace_file_tool(
        ReplaceParams(path=str(file_path), edit=Edit(old="old", new="new"))
    )

    assert isinstance(result, ToolError)
    assert "does not exist" in result.message


@pytest.mark.asyncio
async def test_replace_directory_instead_of_file(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: Path
):
    """Test replacing in a directory instead of a file."""
    dir_path = temp_work_dir / "directory"
    dir_path.mkdir()

    result = await str_replace_file_tool(
        ReplaceParams(path=str(dir_path), edit=Edit(old="old", new="new"))
    )

    assert isinstance(result, ToolError)
    assert "is not a file" in result.message


@pytest.mark.asyncio
async def test_replace_mixed_multiple_edits(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test multiple edits with different replace_all settings."""
    file_path = temp_work_dir / "test.txt"
    original_content = "apple apple banana apple cherry"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(
            path=str(file_path),
            edit=[
                Edit(old="apple", new="fruit", replace_all=False),  # Only first occurrence
                Edit(
                    old="banana", new="tasty", replace_all=True
                ),  # All occurrences (though only one)
            ],
        )
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "fruit apple tasty apple cherry"


@pytest.mark.asyncio
async def test_replace_empty_strings(
    str_replace_file_tool: StrReplaceFile, read_file_tool: ReadFile, temp_work_dir: Path
):
    """Test replacing with empty strings."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    file_path.write_text(original_content)

    await _mark_file_as_read(read_file_tool, file_path)

    result = await str_replace_file_tool(
        ReplaceParams(path=str(file_path), edit=Edit(old="world", new=""))
    )

    assert isinstance(result, ToolOk)
    assert "successfully edited" in result.message
    assert file_path.read_text() == "Hello !"
