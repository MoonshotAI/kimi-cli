"""Tests for the write_file tool."""

from pathlib import Path

import pytest
from kosong.tooling import ToolError, ToolOk
from pydantic import ValidationError

from kimi_cli.tools.file.write import Params, WriteFile


@pytest.mark.asyncio
async def test_write_new_file(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing a new file."""
    file_path = temp_work_dir / "new_file.txt"
    content = "Hello, World!"

    result = await write_file_tool(Params(path=str(file_path), content=content))

    assert isinstance(result, ToolOk)
    assert "successfully overwritten" in result.message
    assert file_path.exists()
    assert file_path.read_text() == content


@pytest.mark.asyncio
async def test_overwrite_existing_file(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test overwriting an existing file."""
    file_path = temp_work_dir / "existing.txt"
    original_content = "Original content"
    file_path.write_text(original_content)

    new_content = "New content"
    result = await write_file_tool(Params(path=str(file_path), content=new_content))

    assert isinstance(result, ToolOk)
    assert "successfully overwritten" in result.message
    assert file_path.read_text() == new_content


@pytest.mark.asyncio
async def test_append_to_file(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test appending to an existing file."""
    file_path = temp_work_dir / "append_test.txt"
    original_content = "First line\n"
    file_path.write_text(original_content)

    append_content = "Second line\n"
    result = await write_file_tool(
        Params(path=str(file_path), content=append_content, mode="append")
    )

    assert isinstance(result, ToolOk)
    assert "successfully appended to" in result.message
    expected_content = original_content + append_content
    assert file_path.read_text() == expected_content


@pytest.mark.asyncio
async def test_write_unicode_content(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing unicode content."""
    file_path = temp_work_dir / "unicode.txt"
    content = "Hello 世界 🌍\nUnicode: café, naïve, résumé"

    result = await write_file_tool(Params(path=str(file_path), content=content))

    assert isinstance(result, ToolOk)
    assert file_path.exists()
    assert file_path.read_text(encoding="utf-8") == content


@pytest.mark.asyncio
async def test_write_empty_content(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing empty content."""
    file_path = temp_work_dir / "empty.txt"
    content = ""

    result = await write_file_tool(Params(path=str(file_path), content=content))

    assert isinstance(result, ToolOk)
    assert file_path.exists()
    assert file_path.read_text() == content


@pytest.mark.asyncio
async def test_write_multiline_content(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing multiline content."""
    file_path = temp_work_dir / "multiline.txt"
    content = "Line 1\nLine 2\nLine 3\n"

    result = await write_file_tool(Params(path=str(file_path), content=content))

    assert isinstance(result, ToolOk)
    assert file_path.read_text() == content


@pytest.mark.asyncio
async def test_write_with_relative_path(write_file_tool: WriteFile):
    """Test writing with a relative path (should fail)."""
    result = await write_file_tool(Params(path="relative/path/file.txt", content="content"))

    assert isinstance(result, ToolError)
    assert "not an absolute path" in result.message


@pytest.mark.asyncio
async def test_write_outside_work_directory(write_file_tool: WriteFile):
    """Test writing outside the working directory (should fail)."""
    import platform

    if platform.system() == "Windows":
        outside_path = "C:\\Windows\\temp\\outside.txt"
    else:
        outside_path = "/tmp/outside.txt"

    result = await write_file_tool(Params(path=outside_path, content="content"))

    assert isinstance(result, ToolError)
    assert "outside the working directory" in result.message


@pytest.mark.asyncio
async def test_write_to_nonexistent_directory(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing to a non-existent directory."""
    file_path = temp_work_dir / "nonexistent" / "file.txt"

    result = await write_file_tool(Params(path=str(file_path), content="content"))

    assert isinstance(result, ToolError)
    assert "parent directory does not exist" in result.message


@pytest.mark.asyncio
async def test_write_with_invalid_mode(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing with an invalid mode."""
    file_path = temp_work_dir / "test.txt"

    with pytest.raises(ValidationError):
        await write_file_tool(Params(path=str(file_path), content="content", mode="invalid"))  # pyright: ignore[reportArgumentType]


@pytest.mark.asyncio
async def test_append_to_nonexistent_file(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test appending to a non-existent file (should create it)."""
    file_path = temp_work_dir / "new_append.txt"
    content = "New content\n"

    result = await write_file_tool(Params(path=str(file_path), content=content, mode="append"))

    assert isinstance(result, ToolOk)
    assert "successfully appended to" in result.message
    assert file_path.exists()
    assert file_path.read_text() == content


@pytest.mark.asyncio
async def test_write_large_content(write_file_tool: WriteFile, temp_work_dir: Path):
    """Test writing large content."""
    file_path = temp_work_dir / "large.txt"
    content = "Large content line\n" * 1000

    result = await write_file_tool(Params(path=str(file_path), content=content))

    assert isinstance(result, ToolOk)
    assert file_path.exists()
    assert file_path.read_text() == content
