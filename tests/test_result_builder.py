"""Tests for ToolResultBuilder."""

from __future__ import annotations

from gitrekt_cli.tools.utils import ToolResultBuilder


def test_basic_functionality():
    """Test basic functionality without limits."""
    builder = ToolResultBuilder(max_chars=50)

    written1 = builder.write("Hello")
    written2 = builder.write(" world")

    assert written1 == 5
    assert written2 == 6

    result = builder.ok("Operation completed")
    assert result.output == "Hello world"
    assert result.message == "Operation completed."
    assert not builder.is_full


def test_char_limit_truncation():
    """Test character limit truncation."""
    builder = ToolResultBuilder(max_chars=10)

    written1 = builder.write("Hello")
    written2 = builder.write(" world!")  # This should trigger truncation

    assert written1 == 5
    assert written2 == 14  # "[...truncated]" marker was added
    assert builder.is_full

    result = builder.ok("Operation completed")
    assert result.output == "Hello[...truncated]"
    assert "Operation completed." in result.message
    assert "Output is truncated" in result.message


def test_line_length_limit():
    """Test line length limit functionality."""
    builder = ToolResultBuilder(max_chars=100, max_line_length=20)

    written = builder.write("This is a very long line that should be truncated\n")

    assert written == 20  # Line was truncated to fit marker

    result = builder.ok()
    assert isinstance(result.output, str)
    assert "[...truncated]" in result.output
    assert "Output is truncated" in result.message


def test_both_limits():
    """Test both character and line limits together."""
    builder = ToolResultBuilder(max_chars=40, max_line_length=20)

    w1 = builder.write("Line 1\n")  # 7 chars
    w2 = builder.write("This is a very long line that exceeds limit\n")  # 20 chars (truncated)
    w3 = builder.write("This would exceed char limit")  # 14 chars (truncated)

    assert w1 == 7
    assert w2 == 20  # Line truncated to fit limit
    assert w3 == 14  # Line truncated due to char limit
    assert builder.is_full
    # Total might exceed 40 due to truncation markers

    result = builder.ok()
    assert isinstance(result.output, str)
    assert "[...truncated]" in result.output
    assert "Output is truncated" in result.message


def test_error_result():
    """Test error result creation."""
    builder = ToolResultBuilder(max_chars=20)

    builder.write("Some output")
    result = builder.error("Something went wrong", brief="Error occurred")

    assert result.output == "Some output"
    assert result.message == "Something went wrong"
    assert result.brief == "Error occurred"


def test_error_with_truncation():
    """Test error result with truncated output."""
    builder = ToolResultBuilder(max_chars=10)

    builder.write("Very long output that exceeds limit")
    result = builder.error("Command failed", brief="Failed")

    assert isinstance(result.output, str)
    assert "[...truncated]" in result.output
    assert "Command failed" in result.message
    assert "Output is truncated" in result.message
    assert result.brief == "Failed"


def test_properties():
    """Test builder properties."""
    builder = ToolResultBuilder(max_chars=20, max_line_length=30)

    assert builder.n_chars == 0
    assert builder.n_lines == 0
    assert not builder.is_full

    builder.write("Short\n")
    assert builder.n_chars == 6
    assert builder.n_lines == 1

    builder.write("1\n2\n")
    assert builder.n_chars == 10
    assert builder.n_lines == 3

    builder.write("More text that exceeds")  # Will trigger char truncation
    assert builder.is_full


def test_write_when_full():
    """Test writing when buffer is already full."""
    builder = ToolResultBuilder(max_chars=5)

    written1 = builder.write("Hello")  # Fills buffer exactly
    written2 = builder.write(" world")  # Should write nothing

    assert written1 == 5
    assert written2 == 0
    assert builder.is_full

    result = builder.ok()
    assert result.output == "Hello"


def test_multiline_handling():
    """Test proper multiline text handling."""
    builder = ToolResultBuilder(max_chars=100)

    written = builder.write("Line 1\nLine 2\nLine 3")

    assert written == 20
    assert builder.n_lines == 2  # Two newlines

    result = builder.ok()
    assert result.output == "Line 1\nLine 2\nLine 3"


def test_empty_write():
    """Test writing empty string."""
    builder = ToolResultBuilder(max_chars=50)

    written = builder.write("")

    assert written == 0
    assert builder.n_chars == 0
    assert not builder.is_full
