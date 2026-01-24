"""Basic Windows cmd tests for the shell tool."""

from __future__ import annotations

import platform

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.tools.shell import Params, Shell

pytestmark = pytest.mark.skipif(
    platform.system() != "Windows", reason="PowerShell tests run only on Windows."
)


async def test_simple_command(shell_tool: Shell):
    """Ensure a basic cmd command runs."""
    result = await shell_tool(Params(command='echo "Hello Windows"'))

    assert not result.is_error
    assert isinstance(result.output, str)
    assert result.output.strip() == snapshot("Hello Windows")
    assert "Command executed successfully" in result.message


async def test_command_with_error(shell_tool: Shell):
    """Failing commands should return a ToolError with exit code info."""
    result = await shell_tool(Params(command='python -c "import sys; sys.exit(1)"'))

    assert result.is_error
    assert result.output == snapshot("")
    assert "Command failed with exit code: 1" in result.message
    assert "Failed with exit code: 1" in result.brief


async def test_command_chaining(shell_tool: Shell):
    """Chaining commands with && should work."""
    result = await shell_tool(Params(command="echo First; if ($?) { echo Second }"))

    assert not result.is_error
    assert isinstance(result.output, str)
    assert result.output.replace("\r\n", "\n") == snapshot("First\nSecond\n")


async def test_file_operations(shell_tool: Shell, temp_work_dir: KaosPath):
    """Basic file write/read using cmd redirection."""
    file_path = temp_work_dir / "test_file.txt"

    create_result = await shell_tool(Params(command=f'echo "Test content" > "{file_path}"'))
    assert create_result.output == snapshot("")
    assert create_result.message == snapshot("Command executed successfully.")
    assert create_result.brief == snapshot("")

    read_result = await shell_tool(Params(command=f'type "{file_path}"'))
    assert read_result.output == snapshot("Test content\r\n")
    assert read_result.message == snapshot("Command executed successfully.")
    assert read_result.brief == snapshot("")
