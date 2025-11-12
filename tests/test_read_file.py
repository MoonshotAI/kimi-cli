"""Tests for the read_file tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kosong.tooling import ToolError, ToolOk

from kimi_cli.tools.file.read import MAX_BYTES, MAX_LINE_LENGTH, MAX_LINES, Params, ReadFile


@pytest.fixture
def sample_file(temp_work_dir: Path) -> Path:
    """Create a sample file with test content."""
    file_path = temp_work_dir / "sample.txt"
    content = """Line 1: Hello World
Line 2: This is a test file
Line 3: With multiple lines
Line 4: For testing purposes
Line 5: End of file"""
    file_path.write_text(content)
    return file_path


@pytest.mark.asyncio
async def test_read_entire_file(read_file_tool: ReadFile, sample_file: Path):
    """Test reading an entire file."""
    result = await read_file_tool(Params(path=str(sample_file)))
    assert result == snapshot(
        ToolOk(
            output="""\
     1	Line 1: Hello World
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
""",
            message="5 lines read from file starting from line 1. End of file reached.",
        )
    )


@pytest.mark.asyncio
async def test_read_with_line_offset(read_file_tool: ReadFile, sample_file: Path):
    """Test reading from a specific line offset."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=3))
    assert result == snapshot(
        ToolOk(
            output="""\
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
""",
            message="3 lines read from file starting from line 3. End of file reached.",
        )
    )


@pytest.mark.asyncio
async def test_read_with_n_lines(read_file_tool: ReadFile, sample_file: Path):
    """Test reading a specific number of lines."""
    result = await read_file_tool(Params(path=str(sample_file), n_lines=2))
    assert result == snapshot(
        ToolOk(
            output="""\
     1	Line 1: Hello World
     2	Line 2: This is a test file
""",
            message="2 lines read from file starting from line 1.",
        )
    )


@pytest.mark.asyncio
async def test_read_with_line_offset_and_n_lines(read_file_tool: ReadFile, sample_file: Path):
    """Test reading with both line offset and n_lines."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=2, n_lines=2))
    assert result == snapshot(
        ToolOk(
            output="""\
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
""",
            message="2 lines read from file starting from line 2.",
        )
    )


@pytest.mark.asyncio
async def test_read_nonexistent_file(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test reading a non-existent file."""
    nonexistent_file = temp_work_dir / "nonexistent.txt"
    result = await read_file_tool(Params(path=str(nonexistent_file)))
    assert result == snapshot(
        ToolError(
            message=(f"`{nonexistent_file}` does not exist."),
            brief="File not found",
        )
    )


@pytest.mark.asyncio
async def test_read_directory_instead_of_file(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test attempting to read a directory."""
    result = await read_file_tool(Params(path=str(temp_work_dir)))
    assert result == snapshot(
        ToolError(
            message=(f"`{temp_work_dir}` is not a file."),
            brief="Invalid path",
        )
    )


@pytest.mark.asyncio
async def test_read_with_relative_path(read_file_tool: ReadFile):
    """Test reading with a relative path (should fail)."""
    result = await read_file_tool(Params(path="relative/path/file.txt"))
    assert result == snapshot(
        ToolError(
            message=(
                "`relative/path/file.txt` is not an absolute path. You must provide an absolute "
                "path to read a file."
            ),
            brief="Invalid path",
        )
    )


@pytest.mark.asyncio
async def test_read_empty_file(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test reading an empty file."""
    empty_file = temp_work_dir / "empty.txt"
    empty_file.write_text("")

    result = await read_file_tool(Params(path=str(empty_file)))
    assert result == snapshot(
        ToolOk(output="", message="No lines read from file. End of file reached.")
    )


@pytest.mark.asyncio
async def test_read_line_offset_beyond_file_length(read_file_tool: ReadFile, sample_file: Path):
    """Test reading with line offset beyond file length."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=10))
    assert result == snapshot(
        ToolOk(output="", message="No lines read from file. End of file reached.")
    )


@pytest.mark.asyncio
async def test_read_unicode_file(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test reading a file with unicode characters."""
    unicode_file = temp_work_dir / "unicode.txt"
    content = "Hello 世界 🌍\nUnicode test: café, naïve, résumé"
    unicode_file.write_text(content, encoding="utf-8")

    result = await read_file_tool(Params(path=str(unicode_file)))
    assert result == snapshot(
        ToolOk(
            output="""\
     1	Hello 世界 🌍
     2	Unicode test: café, naïve, résumé\
""",
            message="2 lines read from file starting from line 1. End of file reached.",
        )
    )


@pytest.mark.asyncio
async def test_read_edge_cases(read_file_tool: ReadFile, sample_file: Path):
    """Test edge cases for line offset reading."""
    # Test reading from line 1 (should be same as default)
    result = await read_file_tool(Params(path=str(sample_file), line_offset=1))
    assert result == snapshot(
        ToolOk(
            output="""\
     1	Line 1: Hello World
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
""",
            message="5 lines read from file starting from line 1. End of file reached.",
        )
    )

    # Test reading from line 5 (last line)
    result = await read_file_tool(Params(path=str(sample_file), line_offset=5))
    assert result == snapshot(
        ToolOk(
            output="     5\tLine 5: End of file",
            message="1 lines read from file starting from line 5. End of file reached.",
        )
    )

    # Test reading with offset and n_lines combined
    result = await read_file_tool(Params(path=str(sample_file), line_offset=2, n_lines=1))
    assert result == snapshot(
        ToolOk(
            output="     2\tLine 2: This is a test file\n",
            message="1 lines read from file starting from line 2.",
        )
    )


@pytest.mark.asyncio
async def test_line_truncation_and_messaging(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test line truncation functionality and messaging."""

    # Test single long line truncation
    single_line_file = temp_work_dir / "single_long_line.txt"
    long_content = "A" * 2500 + " This should be truncated"
    single_line_file.write_text(long_content)

    result = await read_file_tool(Params(path=str(single_line_file)))
    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "1 lines read from" in result.message
    # Check that the line is truncated and ends with "..."
    assert result.output.endswith("...")

    # Verify exact length after truncation (accounting for line number prefix)
    lines = result.output.split("\n")
    content_line = [line for line in lines if line.strip()][0]
    actual_content = content_line.split("\t", 1)[1] if "\t" in content_line else content_line
    assert len(actual_content) == MAX_LINE_LENGTH

    # Test multiple long lines with truncation messaging
    multi_line_file = temp_work_dir / "multi_truncation_test.txt"
    long_line_1 = "A" * 2500
    long_line_2 = "B" * 3000
    normal_line = "Short line"
    content = f"{long_line_1}\n{normal_line}\n{long_line_2}"
    multi_line_file.write_text(content)

    result = await read_file_tool(Params(path=str(multi_line_file)))
    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert result.message == snapshot(
        "3 lines read from file starting from line 1. End of file reached. "
        "Lines [1, 3] were truncated."
    )

    # Verify truncation actually happened for specific lines
    lines = result.output.split("\n")
    endings = [line[-20:] for line in lines]
    assert endings == snapshot(
        [
            "AAAAAAAAAAAAAAAAA...",
            "     2\tShort line",
            "BBBBBBBBBBBBBBBBB...",
        ]
    )


@pytest.mark.asyncio
async def test_parameter_validation_line_offset(read_file_tool: ReadFile, sample_file: Path):
    """Test that line_offset parameter validation works correctly."""
    # Test line_offset < 1 should be rejected by Pydantic validation
    with pytest.raises(ValueError, match="line_offset"):
        Params(path=str(sample_file), line_offset=0)

    with pytest.raises(ValueError, match="line_offset"):
        Params(path=str(sample_file), line_offset=-1)


@pytest.mark.asyncio
async def test_parameter_validation_n_lines(read_file_tool: ReadFile, sample_file: Path):
    """Test that n_lines parameter validation works correctly."""
    # Test n_lines < 1 should be rejected by Pydantic validation
    with pytest.raises(ValueError, match="n_lines"):
        Params(path=str(sample_file), n_lines=0)

    with pytest.raises(ValueError, match="n_lines"):
        Params(path=str(sample_file), n_lines=-1)


@pytest.mark.asyncio
async def test_max_lines_boundary(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test that reading respects the MAX_LINES boundary."""
    # Create a file with more than MAX_LINES lines
    large_file = temp_work_dir / "large_file.txt"
    content = "\n".join([f"Line {i}" for i in range(1, MAX_LINES + 10)])
    large_file.write_text(content)

    # Request more than MAX_LINES to trigger the boundary check
    result = await read_file_tool(Params(path=str(large_file), n_lines=MAX_LINES + 5))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    # Should read MAX_LINES lines, not the full file
    assert f"Max {MAX_LINES} lines reached" in result.message
    # Count actual lines in output (accounting for line numbers)
    output_lines = [line for line in result.output.split("\n") if line.strip()]
    assert len(output_lines) == MAX_LINES


@pytest.mark.asyncio
async def test_max_bytes_boundary(read_file_tool: ReadFile, temp_work_dir: Path):
    """Test that reading respects the MAX_BYTES boundary."""
    # Create a file that exceeds MAX_BYTES
    large_file = temp_work_dir / "large_bytes.txt"
    # Create content that will exceed 100KB but stay under MAX_LINES
    line_content = "A" * 1000  # 1000 characters per line
    num_lines = (MAX_BYTES // 1000) + 5  # Enough to exceed MAX_BYTES
    content = "\n".join([line_content] * num_lines)
    large_file.write_text(content)

    result = await read_file_tool(Params(path=str(large_file)))

    assert isinstance(result, ToolOk)
    assert f"Max {MAX_BYTES} bytes reached" in result.message
