"""Tests for the shell tool."""

from __future__ import annotations

import platform
from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kosong.tooling import ToolError, ToolOk

from kimi_cli.tools.shell import Params, Shell
from kimi_cli.tools.utils import DEFAULT_MAX_CHARS

pytestmark = pytest.mark.skipif(
    platform.system() == "Windows", reason="Shell tool tests are disabled on Windows."
)


@pytest.mark.asyncio
async def test_simple_command(shell_tool: Shell):
    """Test executing a simple command."""
    result = await shell_tool(Params(command="echo 'Hello World'"))
    assert result == snapshot(
        ToolOk(output="Hello World\n", message="Command executed successfully.")
    )


@pytest.mark.asyncio
async def test_command_with_error(shell_tool: Shell):
    """Test executing a command that returns an error."""
    result = await shell_tool(Params(command="ls /nonexistent/directory"))
    assert isinstance(result, ToolError)
    assert isinstance(result.output, str)
    assert "No such file or directory" in result.output
    assert "Command failed with exit code:" in result.message
    assert "Failed with exit code:" in result.brief


@pytest.mark.asyncio
async def test_command_chaining(shell_tool: Shell):
    """Test command chaining with &&."""
    result = await shell_tool(Params(command="echo 'First' && echo 'Second'"))
    assert result == snapshot(
        ToolOk(
            output="""\
First
Second
""",
            message="Command executed successfully.",
        )
    )


@pytest.mark.asyncio
async def test_command_sequential(shell_tool: Shell):
    """Test sequential command execution with ;."""
    result = await shell_tool(Params(command="echo 'One'; echo 'Two'"))
    assert result == snapshot(
        ToolOk(
            output="""\
One
Two
""",
            message="Command executed successfully.",
        )
    )


@pytest.mark.asyncio
async def test_command_conditional(shell_tool: Shell):
    """Test conditional command execution with ||."""
    result = await shell_tool(Params(command="false || echo 'Success'"))
    assert result == snapshot(ToolOk(output="Success\n", message="Command executed successfully."))


@pytest.mark.asyncio
async def test_command_pipe(shell_tool: Shell):
    """Test command piping."""
    result = await shell_tool(Params(command="echo 'Hello World' | wc -w"))
    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert result.output.strip() == snapshot("2")


@pytest.mark.asyncio
async def test_multiple_pipes(shell_tool: Shell):
    """Test multiple pipes in one command."""
    result = await shell_tool(Params(command="echo -e '1\\n2\\n3' | grep '2' | wc -l"))
    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert result.output.strip() == snapshot("1")


@pytest.mark.asyncio
async def test_command_with_timeout(shell_tool: Shell):
    """Test command execution with timeout."""
    result = await shell_tool(Params(command="sleep 0.1", timeout=1))
    assert result == snapshot(ToolOk(output="", message="Command executed successfully."))


@pytest.mark.asyncio
async def test_command_timeout_expires(shell_tool: Shell):
    """Test command that times out."""
    result = await shell_tool(Params(command="sleep 2", timeout=1))
    assert result == snapshot(
        ToolError(message="Command killed by timeout (1s)", brief="Killed by timeout (1s)")
    )


@pytest.mark.asyncio
async def test_environment_variables(shell_tool: Shell):
    """Test setting and using environment variables."""
    result = await shell_tool(Params(command="export TEST_VAR='test_value' && echo $TEST_VAR"))
    assert result == snapshot(
        ToolOk(output="test_value\n", message="Command executed successfully.")
    )


@pytest.mark.asyncio
async def test_file_operations(shell_tool: Shell, temp_work_dir: Path):
    """Test basic file operations."""
    # Create a test file
    result = await shell_tool(
        Params(command=f"echo 'Test content' > {temp_work_dir}/test_file.txt")
    )
    assert result == snapshot(ToolOk(output="", message="Command executed successfully."))

    # Read the file
    result = await shell_tool(Params(command=f"cat {temp_work_dir}/test_file.txt"))
    assert result == snapshot(
        ToolOk(output="Test content\n", message="Command executed successfully.")
    )


@pytest.mark.asyncio
async def test_text_processing(shell_tool: Shell):
    """Test text processing commands."""
    result = await shell_tool(Params(command="echo 'apple banana cherry' | sed 's/banana/orange/'"))
    assert result == snapshot(
        ToolOk(output="apple orange cherry\n", message="Command executed successfully.")
    )


@pytest.mark.asyncio
async def test_command_substitution(shell_tool: Shell):
    """Test command substitution with a portable command."""
    result = await shell_tool(Params(command='echo "Result: $(echo hello)"'))
    assert result == snapshot(
        ToolOk(output="Result: hello\n", message="Command executed successfully.")
    )


@pytest.mark.asyncio
async def test_arithmetic_substitution(shell_tool: Shell):
    """Test arithmetic substitution - more portable than date command."""
    result = await shell_tool(Params(command='echo "Answer: $((2 + 2))"'))
    assert result == snapshot(
        ToolOk(output="Answer: 4\n", message="Command executed successfully.")
    )


@pytest.mark.asyncio
async def test_very_long_output(shell_tool: Shell):
    """Test command that produces very long output."""
    result = await shell_tool(Params(command="seq 1 100 | head -50"))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    assert "1" in result.output
    assert "50" in result.output
    assert "51" not in result.output  # Should not contain 51


@pytest.mark.asyncio
async def test_output_truncation_on_success(shell_tool: Shell):
    """Test that very long output gets truncated on successful command."""
    # Generate output longer than MAX_OUTPUT_LENGTH
    oversize_length = DEFAULT_MAX_CHARS + 1000
    result = await shell_tool(Params(command=f"python3 -c \"print('X' * {oversize_length})\""))

    assert isinstance(result, ToolOk)
    assert isinstance(result.output, str)
    # Check if output was truncated (it should be)
    if len(result.output) > DEFAULT_MAX_CHARS:
        assert result.output.endswith("[...truncated]\n")
        assert "Output is truncated" in result.message
    assert "Command executed successfully" in result.message


@pytest.mark.asyncio
async def test_output_truncation_on_failure(shell_tool: Shell):
    """Test that very long output gets truncated even when command fails."""
    # Generate long output with a command that will fail
    result = await shell_tool(
        Params(command="python3 -c \"import sys; print('ERROR_' * 8000); sys.exit(1)\"")
    )

    assert isinstance(result, ToolError)
    assert isinstance(result.output, str)
    # Check if output was truncated
    if len(result.output) > DEFAULT_MAX_CHARS:
        assert result.output.endswith("[...truncated]\n")
        assert "Output is truncated" in result.message
    assert "Command failed with exit code:" in result.message


@pytest.mark.asyncio
async def test_timeout_parameter_validation_bounds(shell_tool: Shell):
    """Test timeout parameter validation (bounds checking)."""
    # Test timeout < 1 (should fail validation)
    with pytest.raises(ValueError, match="timeout"):
        Params(command="echo test", timeout=0)

    with pytest.raises(ValueError, match="timeout"):
        Params(command="echo test", timeout=-1)

    # Test timeout > MAX_TIMEOUT (should fail validation)
    from kimi_cli.tools.shell import MAX_TIMEOUT

    with pytest.raises(ValueError, match="timeout"):
        Params(command="echo test", timeout=MAX_TIMEOUT + 1)
