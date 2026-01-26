"""Tests for the grep tool."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from inline_snapshot import snapshot

from kimi_cli.tools.file.grep_local import Grep, Params
from kimi_cli.tools.utils import DEFAULT_MAX_CHARS


@pytest.fixture
def temp_test_files():
    """Create temporary test files for grep testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create test files
        test_file1 = Path(temp_dir) / "test1.py"
        test_file1.write_text("""def hello_world():
    print("Hello, World!")
    return "hello"

class TestClass:
    def __init__(self):
        self.message = "hello there"
""")

        test_file2 = Path(temp_dir) / "test2.js"
        test_file2.write_text("""function helloWorld() {
    console.log("Hello, World!");
    return "hello";
}

class TestClass {
    constructor() {
        this.message = "hello there";
    }
}
""")

        test_file3 = Path(temp_dir) / "readme.txt"
        test_file3.write_text("""This is a readme file.
It contains some text.
Hello world example is here.
""")

        # Create a subdirectory with files
        subdir = Path(temp_dir) / "subdir"
        subdir.mkdir()
        subfile = subdir / "subtest.py"
        subfile.write_text("def sub_hello():\n    return 'hello from subdir'\n")

        yield temp_dir, [test_file1, test_file2, test_file3, subfile]


async def test_grep_files_with_matches(grep_tool: Grep, temp_test_files):
    """Test finding files that contain a pattern."""
    temp_dir, test_files = temp_test_files

    # Test basic pattern matching to catch "Hello" in readme.txt
    result = await grep_tool(
        Params(pattern="Hello", path=temp_dir, output_mode="files_with_matches")
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should find all test files that contain "hello" (case insensitive)
    assert "test1.py" in result.output
    assert "test2.js" in result.output
    assert "readme.txt" in result.output


async def test_grep_content_mode(grep_tool: Grep, temp_test_files):
    """Test showing matching lines with content."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "content",
                "-n": True,
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should show matching lines with line numbers
    assert "hello" in result.output.lower()
    assert ":" in result.output  # Line numbers should be present


async def test_grep_case_insensitive(grep_tool: Grep, temp_test_files):
    """Test case insensitive search."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "HELLO",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should find files with "hello" (lowercase)
    assert "test1.py" in result.output


async def test_grep_with_context(grep_tool: Grep, temp_test_files):
    """Test showing context around matches."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "TestClass",
                "path": temp_dir,
                "output_mode": "content",
                "-C": 1,
                "-n": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should show context lines
    lines = result.output.split("\n")
    assert len(lines) > 2  # Should have more than just the matching line


async def test_grep_count_matches(grep_tool: Grep, temp_test_files):
    """Test counting matches."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "count_matches",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should show count for each file
    assert "test1.py" in result.output
    assert "test2.js" in result.output


async def test_grep_with_glob_pattern(grep_tool: Grep, temp_test_files):
    """Test filtering files with glob pattern."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "glob": "*.py",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should only find Python files
    assert "test1.py" in result.output
    assert "subtest.py" in result.output
    assert "test2.js" not in result.output
    assert "readme.txt" not in result.output


async def test_grep_with_type_filter(grep_tool: Grep, temp_test_files):
    """Test filtering by file type."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "type": "py",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should only find Python files
    assert "test1.py" in result.output
    assert "subtest.py" in result.output
    assert "test2.js" not in result.output
    assert "readme.txt" not in result.output


async def test_grep_head_limit(grep_tool: Grep, temp_test_files):
    """Test limiting number of results."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "head_limit": 2,
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should limit results to 2 files
    lines = [
        line for line in result.output.split("\n") if line.strip() and not line.startswith("...")
    ]
    assert len(lines) <= 2
    assert "... (results truncated to 2 lines)" in result.output


async def test_grep_output_truncation(grep_tool: Grep):
    """Ensure extremely long output is truncated automatically."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_file = Path(temp_dir) / "big.txt"
        test_file.write_text(
            "match line with filler content that keeps growing for truncation purposes\n" * 2000
        )

        result = await grep_tool(
            Params.model_validate(
                {
                    "pattern": "match",
                    "path": temp_dir,
                    "output_mode": "content",
                    "-n": True,
                }
            )
        )

        assert not result.is_error
        assert isinstance(result.output, str)
        assert result.message == snapshot("Output is truncated to fit in the message.")
        assert len(result.output) < DEFAULT_MAX_CHARS + 100


async def test_grep_multiline_mode(grep_tool: Grep):
    """Test multiline pattern matching."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create a file with multiline content
        test_file = Path(temp_dir) / "multiline.py"
        test_file.write_text(
            """def function():
    '''This is a
    multiline docstring'''
    pass
""",
            newline="\n",
        )

        # Test multiline pattern
        result = await grep_tool(
            Params(
                pattern=r"This is a\n    multiline",
                path=temp_dir,
                output_mode="content",
                multiline=True,
            )
        )
        assert not result.is_error
        assert isinstance(result.output, str)

        # Should find the multiline pattern
        assert "This is a" in result.output
        assert "multiline" in result.output


async def test_grep_no_matches(grep_tool: Grep):
    """Test when no matches are found."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_file = Path(temp_dir) / "empty.py"
        test_file.write_text("# This file has no matching content\n")

        result = await grep_tool(
            Params(pattern="nonexistent_pattern", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert result.output == ""
        assert "No matches found" in result.message


async def test_grep_invalid_pattern(grep_tool: Grep):
    """Test with invalid regex pattern."""
    result = await grep_tool(Params(pattern="[invalid", path=".", output_mode="files_with_matches"))
    # Should handle the error gracefully
    assert isinstance(result.output, str)  # Should have output either way


async def test_grep_single_file(grep_tool: Grep):
    """Test searching in a single file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py") as f:
        f.write("def test_function():\n    return 'hello world'\n")
        f.flush()

        result = await grep_tool(
            Params.model_validate(
                {
                    "pattern": "hello",
                    "path": f.name,
                    "output_mode": "content",
                    "-n": True,
                }
            )
        )
        assert not result.is_error
        assert isinstance(result.output, str)

        assert "hello" in result.output
        # For single file search, filename might not be in content output
        # Let's just check that we got valid content
        assert len(result.output.strip()) > 0


async def test_grep_before_after_context(grep_tool: Grep, temp_test_files):
    """Test before and after context separately."""
    temp_dir, test_files = temp_test_files

    # Test before context
    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "TestClass",
                "path": temp_dir,
                "output_mode": "content",
                "-B": 2,
                "-n": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)
    assert "TestClass" in result.output
    assert "}" in result.output
    assert 'return "hello"' in result.output
    assert "Hello, World!" not in result.output

    # Test after context
    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "TestClass",
                "path": temp_dir,
                "output_mode": "content",
                "-A": 2,
                "-n": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)
    assert "TestClass" in result.output
    assert "constructor()" in result.output
    assert "this.message" in result.output
    assert "}" not in result.output
