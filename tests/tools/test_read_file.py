"""Tests for the read_file tool."""

from __future__ import annotations

from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.tools.file.read import (
    MAX_BYTES,
    MAX_LINE_LENGTH,
    MAX_LINES,
    Params,
    ReadFile,
)


@pytest.fixture
async def sample_file(temp_work_dir: KaosPath) -> KaosPath:
    """Create a sample file with test content."""
    file_path = temp_work_dir / "sample.txt"
    content = """Line 1: Hello World
Line 2: This is a test file
Line 3: With multiple lines
Line 4: For testing purposes
Line 5: End of file"""
    await file_path.write_text(content)
    return file_path


async def test_read_entire_file(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test reading an entire file."""
    result = await read_file_tool(Params(path=str(sample_file)))
    assert not result.is_error
    assert result.output == snapshot(
        """\
     1	Line 1: Hello World
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
"""
    )
    assert result.message == snapshot(
        "5 lines read from file starting from line 1. Total lines in file: 5. End of file reached."
    )


async def test_read_with_line_offset(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test reading from a specific line offset."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=3))
    assert not result.is_error
    assert result.output == snapshot(
        """\
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
"""
    )
    assert result.message == snapshot(
        "3 lines read from file starting from line 3. Total lines in file: 5. End of file reached."
    )


async def test_read_with_n_lines(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test reading a specific number of lines."""
    result = await read_file_tool(Params(path=str(sample_file), n_lines=2))
    assert not result.is_error
    assert result.output == snapshot(
        """\
     1	Line 1: Hello World
     2	Line 2: This is a test file
"""
    )
    assert result.message == snapshot(
        "2 lines read from file starting from line 1. Total lines in file: 5."
    )


async def test_read_with_line_offset_and_n_lines(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test reading with both line offset and n_lines."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=2, n_lines=2))
    assert not result.is_error
    assert result.output == snapshot(
        """\
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
"""
    )
    assert result.message == snapshot(
        "2 lines read from file starting from line 2. Total lines in file: 5."
    )


async def test_read_nonexistent_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading a non-existent file."""
    nonexistent_file = temp_work_dir / "nonexistent.txt"
    result = await read_file_tool(Params(path=str(nonexistent_file)))
    assert result.is_error
    assert result.message == snapshot(f"`{nonexistent_file}` does not exist.")
    assert result.brief == snapshot("File not found")


async def test_read_directory_instead_of_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test attempting to read a directory."""
    result = await read_file_tool(Params(path=str(temp_work_dir)))
    assert result.is_error
    assert result.message == snapshot(f"`{temp_work_dir}` is not a file.")
    assert result.brief == snapshot("Invalid path")


async def test_read_with_relative_path(
    read_file_tool: ReadFile, temp_work_dir: KaosPath, sample_file: KaosPath
):
    """Test reading with a relative path."""
    result = await read_file_tool(Params(path=str(sample_file.relative_to(temp_work_dir))))
    assert not result.is_error
    assert result.message == snapshot(
        "5 lines read from file starting from line 1. Total lines in file: 5. End of file reached."
    )
    assert result.output == snapshot("""\
     1	Line 1: Hello World
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
""")


async def test_read_with_relative_path_outside_work_dir(
    read_file_tool: ReadFile, temp_work_dir: KaosPath
):
    """Test reading a file outside the work directory with a relative path (should fail)."""
    path = Path("..") / "outside_file.txt"
    result = await read_file_tool(Params(path=str(path)))
    assert result.is_error
    assert result.message == snapshot(
        f"`{path}` is not an absolute path. "
        "You must provide an absolute path to read a file outside the working directory."
    )
    assert result.output == snapshot("")


async def test_read_empty_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading an empty file."""
    empty_file = temp_work_dir / "empty.txt"
    await empty_file.write_text("")

    result = await read_file_tool(Params(path=str(empty_file)))
    assert not result.is_error
    assert result.output == snapshot("")
    assert result.message == snapshot(
        "No lines read from file. Total lines in file: 0. End of file reached."
    )


async def test_read_image_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading an image file."""
    image_file = temp_work_dir / "sample.png"
    data = b"\x89PNG\r\n\x1a\n" + b"pngdata"
    await image_file.write_bytes(data)

    result = await read_file_tool(Params(path=str(image_file)))

    assert result.is_error
    assert result.message == snapshot(
        f"`{image_file}` is a image file. Use other appropriate tools to read image or video files."
    )
    assert result.brief == snapshot("Unsupported file type")


async def test_read_extensionless_image_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading an extensionless image file."""
    image_file = temp_work_dir / "sample"
    data = b"\x89PNG\r\n\x1a\n" + b"pngdata"
    await image_file.write_bytes(data)

    result = await read_file_tool(Params(path=str(image_file)))

    assert result.is_error
    assert result.message == snapshot(
        f"`{image_file}` is a image file. Use other appropriate tools to read image or video files."
    )
    assert result.brief == snapshot("Unsupported file type")


async def test_read_video_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading a video file."""
    video_file = temp_work_dir / "sample.mp4"
    data = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    await video_file.write_bytes(data)

    result = await read_file_tool(Params(path=str(video_file)))

    assert result.is_error
    assert result.message == snapshot(
        f"`{video_file}` is a video file. Use other appropriate tools to read image or video files."
    )
    assert result.brief == snapshot("Unsupported file type")


async def test_read_line_offset_beyond_file_length(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test reading with line offset beyond file length."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=10))
    assert not result.is_error
    assert result.output == snapshot("")
    assert result.message == snapshot(
        "No lines read from file. Total lines in file: 5. End of file reached."
    )


async def test_read_unicode_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading a file with unicode characters."""
    unicode_file = temp_work_dir / "unicode.txt"
    content = "Hello 世界 🌍\nUnicode test: café, naïve, résumé"
    await unicode_file.write_text(content, encoding="utf-8")

    result = await read_file_tool(Params(path=str(unicode_file)))
    assert not result.is_error
    assert result.output == snapshot(
        """\
     1	Hello 世界 🌍
     2	Unicode test: café, naïve, résumé\
"""
    )
    assert result.message == snapshot(
        "2 lines read from file starting from line 1. Total lines in file: 2. End of file reached."
    )


async def test_read_edge_cases(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test edge cases for line offset reading."""
    # Test reading from line 1 (should be same as default)
    result = await read_file_tool(Params(path=str(sample_file), line_offset=1))
    assert not result.is_error
    assert result.output == snapshot(
        """\
     1	Line 1: Hello World
     2	Line 2: This is a test file
     3	Line 3: With multiple lines
     4	Line 4: For testing purposes
     5	Line 5: End of file\
"""
    )
    assert result.message == snapshot(
        "5 lines read from file starting from line 1. Total lines in file: 5. End of file reached."
    )

    # Test reading from line 5 (last line)
    result = await read_file_tool(Params(path=str(sample_file), line_offset=5))
    assert not result.is_error
    assert result.output == snapshot("     5\tLine 5: End of file")
    assert result.message == snapshot(
        "1 lines read from file starting from line 5. Total lines in file: 5. End of file reached."
    )

    # Test reading with offset and n_lines combined
    result = await read_file_tool(Params(path=str(sample_file), line_offset=2, n_lines=1))
    assert not result.is_error
    assert result.output == snapshot("     2\tLine 2: This is a test file\n")
    assert result.message == snapshot(
        "1 lines read from file starting from line 2. Total lines in file: 5."
    )


async def test_line_truncation_and_messaging(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test line truncation functionality and messaging."""

    # Test single long line truncation
    single_line_file = temp_work_dir / "single_long_line.txt"
    long_content = "A" * 2500 + " This should be truncated"
    await single_line_file.write_text(long_content)

    result = await read_file_tool(Params(path=str(single_line_file)))
    assert not result.is_error
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
    await multi_line_file.write_text(content)

    result = await read_file_tool(Params(path=str(multi_line_file)))
    assert not result.is_error
    assert isinstance(result.output, str)
    assert result.message == snapshot(
        "3 lines read from file starting from line 1. Total lines in file: 3. End of file reached. Lines [1, 3] were truncated."
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


async def test_parameter_validation_line_offset(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test that line_offset parameter validation works correctly."""
    # line_offset=0 is invalid (must be positive or negative, not zero)
    with pytest.raises(ValueError, match="line_offset"):
        Params(path=str(sample_file), line_offset=0)

    # Negative values are now valid (tail mode)
    params = Params(path=str(sample_file), line_offset=-1)
    assert params.line_offset == -1

    # Negative offset exceeding MAX_LINES should be rejected
    with pytest.raises(ValueError, match="line_offset"):
        Params(path=str(sample_file), line_offset=-(MAX_LINES + 1))

    # Exactly -MAX_LINES should be accepted
    params = Params(path=str(sample_file), line_offset=-MAX_LINES)
    assert params.line_offset == -MAX_LINES


async def test_parameter_validation_n_lines(read_file_tool: ReadFile, sample_file: KaosPath):
    """Test that n_lines parameter validation works correctly."""
    # Test n_lines < 1 should be rejected by Pydantic validation
    with pytest.raises(ValueError, match="n_lines"):
        Params(path=str(sample_file), n_lines=0)

    with pytest.raises(ValueError, match="n_lines"):
        Params(path=str(sample_file), n_lines=-1)


async def test_max_lines_boundary(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test that reading respects the MAX_LINES boundary."""
    # Create a file with more than MAX_LINES lines
    large_file = temp_work_dir / "large_file.txt"
    content = "\n".join([f"Line {i}" for i in range(1, MAX_LINES + 10)])
    await large_file.write_text(content)

    # Request more than MAX_LINES to trigger the boundary check
    result = await read_file_tool(Params(path=str(large_file), n_lines=MAX_LINES + 5))

    assert not result.is_error
    assert isinstance(result.output, str)
    # Should read MAX_LINES lines, not the full file
    assert f"Max {MAX_LINES} lines reached" in result.message
    # Count actual lines in output (accounting for line numbers)
    output_lines = [line for line in result.output.split("\n") if line.strip()]
    assert len(output_lines) == MAX_LINES


async def test_max_bytes_boundary(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test that reading respects the MAX_BYTES boundary."""
    # Create a file that exceeds MAX_BYTES
    large_file = temp_work_dir / "large_bytes.txt"
    # Create content that will exceed 100KB but stay under MAX_LINES
    line_content = "A" * 1000  # 1000 characters per line
    num_lines = (MAX_BYTES // 1000) + 5  # Enough to exceed MAX_BYTES
    content = "\n".join([line_content] * num_lines)
    await large_file.write_text(content)

    result = await read_file_tool(Params(path=str(large_file)))

    assert not result.is_error
    assert f"Max {MAX_BYTES} bytes reached" in result.message


async def test_read_with_tilde_path_expansion(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Test reading with ~ path expansion."""
    # Create a test file in temp_work_dir and use ~ to reference it
    # We simulate by creating a file and checking that ~ expands correctly
    home = Path.home()
    test_file = home / ".kimi_test_expanduser_temp"
    test_content = "Test content for tilde expansion"

    try:
        # Create the test file in home directory
        test_file.write_text(test_content)

        # Read using ~ path
        result = await read_file_tool(Params(path="~/.kimi_test_expanduser_temp"))

        assert not result.is_error
        assert "Test content for tilde expansion" in result.output
        assert result.message == snapshot(
            "1 lines read from file starting from line 1. Total lines in file: 1. End of file reached."
        )
    finally:
        # Clean up
        if test_file.exists():
            test_file.unlink()


async def test_read_rejects_sensitive_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """ReadFile should block reading files that match sensitive patterns."""
    env_file = temp_work_dir / ".env"
    await env_file.write_text("SECRET_KEY=hunter2\n")

    result = await read_file_tool(Params(path=str(env_file)))

    assert result.is_error
    assert "sensitive" in result.message.lower() or "secrets" in result.message.lower()
    assert "blocked" in result.message.lower() or "protect" in result.message.lower()


async def test_read_allows_non_sensitive_dotfile(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """ReadFile should allow reading non-sensitive dotfiles like .gitignore."""
    gitignore = temp_work_dir / ".gitignore"
    await gitignore.write_text("node_modules/\n")

    result = await read_file_tool(Params(path=str(gitignore)))

    assert not result.is_error
    assert "node_modules" in result.output


# ── Tests for totalLines and tail (negative offset) ──────────────────────────


async def test_read_tail_basic(read_file_tool: ReadFile, sample_file: KaosPath):
    """Negative line_offset=-3 on a 5-line file should return the last 3 lines."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=-3))
    assert not result.is_error
    # Should return lines 3, 4, 5 with absolute line numbers
    assert "     3\tLine 3: With multiple lines\n" in result.output
    assert "     4\tLine 4: For testing purposes\n" in result.output
    assert "     5\tLine 5: End of file" in result.output
    # Should NOT contain lines 1 or 2
    assert "Line 1:" not in result.output
    assert "Line 2:" not in result.output
    # Message must include total lines info
    assert "Total lines in file: 5." in result.message


async def test_read_tail_with_n_lines(read_file_tool: ReadFile, sample_file: KaosPath):
    """Negative offset=-5 with n_lines=2 should return 2 lines starting from the tail position."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=-5, n_lines=2))
    assert not result.is_error
    # -5 on a 5-line file means start from line 1, then n_lines=2 limits to lines 1-2
    assert "     1\tLine 1: Hello World\n" in result.output
    assert "     2\tLine 2: This is a test file\n" in result.output
    assert "Line 3:" not in result.output
    assert "Total lines in file: 5." in result.message


async def test_read_tail_exceeds_file(read_file_tool: ReadFile, sample_file: KaosPath):
    """Negative offset exceeding file length should return the entire file."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=-100))
    assert not result.is_error
    # Should return all 5 lines
    assert "     1\tLine 1: Hello World\n" in result.output
    assert "     5\tLine 5: End of file" in result.output
    assert "Total lines in file: 5." in result.message


async def test_read_tail_empty_file(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Negative offset on an empty file should return nothing with totalLines=0."""
    empty_file = temp_work_dir / "empty_tail.txt"
    await empty_file.write_text("")

    result = await read_file_tool(Params(path=str(empty_file), line_offset=-10))
    assert not result.is_error
    assert result.output == ""
    assert "Total lines in file: 0." in result.message


async def test_read_total_lines_with_positive_offset(
    read_file_tool: ReadFile, sample_file: KaosPath
):
    """Positive offset should also include totalLines in the message."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=3, n_lines=1))
    assert not result.is_error
    # Should return only line 3
    assert "     3\tLine 3: With multiple lines" in result.output
    assert "Line 1:" not in result.output
    assert "Line 4:" not in result.output
    # Message must include total lines even for positive offset
    assert "Total lines in file: 5." in result.message


async def test_read_tail_last_line(read_file_tool: ReadFile, sample_file: KaosPath):
    """line_offset=-1 should return only the last line with correct absolute line number."""
    result = await read_file_tool(Params(path=str(sample_file), line_offset=-1))
    assert not result.is_error
    assert result.output == "     5\tLine 5: End of file"
    assert "1 lines read from file starting from line 5." in result.message
    assert "Total lines in file: 5." in result.message
    assert "End of file reached." in result.message


async def test_read_tail_max_lines(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Tail mode with -MAX_LINES on a file larger than MAX_LINES should return MAX_LINES lines."""
    # Create a file with more than MAX_LINES lines
    large_file = temp_work_dir / "tail_large.txt"
    total = MAX_LINES + 500  # 1500 lines
    content = "\n".join([f"Line {i}" for i in range(1, total + 1)])
    await large_file.write_text(content)

    # Use -MAX_LINES (the maximum allowed negative offset)
    result = await read_file_tool(Params(path=str(large_file), line_offset=-MAX_LINES))
    assert not result.is_error
    assert f"Total lines in file: {total}." in result.message
    # deque captures last 1000 lines (501-1500), n_lines defaults to MAX_LINES so all 1000 are output
    assert isinstance(result.output, str)
    output_lines = [line for line in result.output.split("\n") if line.strip()]
    assert len(output_lines) == MAX_LINES
    # First line should be line 501 (total - MAX_LINES + 1)
    assert output_lines[0].endswith(f"Line {total - MAX_LINES + 1}")


async def test_read_tail_max_bytes(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Tail mode MAX_BYTES truncation should keep newest lines (closest to EOF)."""
    large_file = temp_work_dir / "tail_bytes.txt"
    # Each line ~1001 bytes (1000 chars + \n), need > 100KB to exceed MAX_BYTES
    num_lines = (MAX_BYTES // 1001) + 20
    # Tag each line with its number so we can verify which lines are kept
    lines_data = [f"{i:04d}{'B' * 996}" for i in range(1, num_lines + 1)]
    content = "\n".join(lines_data)
    await large_file.write_text(content)

    result = await read_file_tool(Params(path=str(large_file), line_offset=-(num_lines)))
    assert not result.is_error
    assert f"Max {MAX_BYTES} bytes reached" in result.message
    assert f"Total lines in file: {num_lines}." in result.message

    # Verify that the LAST line of the file is included (newest lines kept)
    assert isinstance(result.output, str)
    output_lines = [x for x in result.output.split("\n") if x.strip()]
    last_output = output_lines[-1].split("\t", 1)[1]
    assert last_output.startswith(f"{num_lines:04d}"), (
        "MAX_BYTES truncation should keep newest lines closest to EOF"
    )
    # Verify that the first output line is NOT line 1 (oldest lines trimmed)
    first_output = output_lines[0].split("\t", 1)[1]
    assert not first_output.startswith("0001"), "MAX_BYTES truncation should trim oldest lines"


async def test_read_tail_n_lines_not_affected_by_byte_cap(
    read_file_tool: ReadFile, temp_work_dir: KaosPath
):
    """Small n_lines should not be affected by MAX_BYTES truncation.

    Regression test: line_offset=-N, n_lines=1 on a file with long lines
    should return the first line of the tail window, not a line shifted by byte-cap.
    """
    large_file = temp_work_dir / "tail_nlines_bytecap.txt"
    # Create a file where tail_buf total bytes >> MAX_BYTES but n_lines=1 is fine.
    # Each line ~2000 bytes (after truncation), 500 lines total.
    num_lines = 500
    lines_data = [f"{i:04d}{'X' * 1996}" for i in range(1, num_lines + 1)]
    content = "\n".join(lines_data)
    await large_file.write_text(content)

    # Request tail window of 200 lines but only read 1
    result = await read_file_tool(Params(path=str(large_file), line_offset=-200, n_lines=1))
    assert not result.is_error
    assert isinstance(result.output, str)

    # The first line of the tail window (last 200 lines) is line 301
    output_lines = [x for x in result.output.split("\n") if x.strip()]
    assert len(output_lines) == 1
    line_content = output_lines[0].split("\t", 1)[1]
    assert line_content.startswith("0301"), (
        f"Expected line 301 (start of tail window), got content starting with: {line_content[:10]}"
    )
    # Should NOT report MAX_BYTES since 1 line is well within budget
    assert "Max" not in result.message


async def test_read_tail_line_truncation(read_file_tool: ReadFile, temp_work_dir: KaosPath):
    """Tail mode should correctly report truncated lines via was_truncated flag in deque."""
    trunc_file = temp_work_dir / "tail_truncation.txt"
    short_line = "Short line"
    long_line = "X" * 2500  # Exceeds MAX_LINE_LENGTH=2000
    # 5 lines: short, long, short, long, short
    content = f"{short_line}\n{long_line}\n{short_line}\n{long_line}\n{short_line}"
    await trunc_file.write_text(content)

    # Read last 3 lines (lines 3, 4, 5)
    result = await read_file_tool(Params(path=str(trunc_file), line_offset=-3))
    assert not result.is_error
    assert "Total lines in file: 5." in result.message
    # Line 4 is a long line that should be truncated
    assert "Lines [4] were truncated." in result.message
    # Verify the truncated line ends with "..."
    assert isinstance(result.output, str)
    output_lines = result.output.split("\n")
    line_4 = [x for x in output_lines if x.strip().startswith("4")][0]
    actual_content = line_4.split("\t", 1)[1]
    assert actual_content.endswith("...")
