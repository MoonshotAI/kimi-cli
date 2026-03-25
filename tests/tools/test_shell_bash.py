"""Tests for the shell tool."""

from __future__ import annotations

import asyncio
import platform

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.tools.shell import Params, Shell
from kimi_cli.tools.utils import DEFAULT_MAX_CHARS

pytestmark = pytest.mark.skipif(
    platform.system() == "Windows", reason="Bash tests run only on non-Windows."
)


async def test_simple_command(shell_tool: Shell):
    """Test executing a simple command."""
    result = await shell_tool(Params(command="echo 'Hello World'"))
    assert not result.is_error
    assert result.output == snapshot("Hello World\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_command_with_error(shell_tool: Shell):
    """Test executing a command that returns an error."""
    result = await shell_tool(Params(command="ls /nonexistent/directory"))
    assert result.is_error
    assert isinstance(result.output, str)
    assert "No such file or directory" in result.output
    assert "Command failed with exit code:" in result.message
    assert "Failed with exit code:" in result.brief


async def test_command_chaining(shell_tool: Shell):
    """Test command chaining with &&."""
    result = await shell_tool(Params(command="echo 'First' && echo 'Second'"))
    assert not result.is_error
    assert result.output == snapshot("""\
First
Second
""")
    assert result.message == snapshot("Command executed successfully.")


async def test_command_sequential(shell_tool: Shell):
    """Test sequential command execution with ;."""
    result = await shell_tool(Params(command="echo 'One'; echo 'Two'"))
    assert not result.is_error
    assert result.output == snapshot("""\
One
Two
""")
    assert result.message == snapshot("Command executed successfully.")


async def test_command_conditional(shell_tool: Shell):
    """Test conditional command execution with ||."""
    result = await shell_tool(Params(command="false || echo 'Success'"))
    assert not result.is_error
    assert result.output == snapshot("Success\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_command_pipe(shell_tool: Shell):
    """Test command piping."""
    result = await shell_tool(Params(command="echo 'Hello World' | wc -w"))
    assert not result.is_error
    assert isinstance(result.output, str)
    assert result.output.strip() == snapshot("2")


async def test_multiple_pipes(shell_tool: Shell):
    """Test multiple pipes in one command."""
    result = await shell_tool(Params(command="echo -e '1\\n2\\n3' | grep '2' | wc -l"))
    assert not result.is_error
    assert isinstance(result.output, str)
    assert result.output.strip() == snapshot("1")


async def test_command_with_timeout(shell_tool: Shell):
    """Test command execution with timeout."""
    result = await shell_tool(Params(command="sleep 0.1", timeout=1))
    assert not result.is_error
    assert result.output == snapshot("")
    assert result.message == snapshot("Command executed successfully.")


async def test_command_timeout_expires(shell_tool: Shell):
    """Test command that times out."""
    result = await shell_tool(Params(command="sleep 2", timeout=1))
    assert result.is_error
    assert result.message == snapshot("Command killed by timeout (1s)")
    assert result.brief == snapshot("Killed by timeout (1s)")


async def test_environment_variables(shell_tool: Shell):
    """Test setting and using environment variables."""
    result = await shell_tool(Params(command="export TEST_VAR='test_value' && echo $TEST_VAR"))
    assert not result.is_error
    assert result.output == snapshot("test_value\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_file_operations(shell_tool: Shell, temp_work_dir: KaosPath):
    """Test basic file operations."""
    # Create a test file
    result = await shell_tool(
        Params(command=f"echo 'Test content' > {temp_work_dir}/test_file.txt")
    )
    assert not result.is_error
    assert result.output == snapshot("")
    assert result.message == snapshot("Command executed successfully.")

    # Read the file
    result = await shell_tool(Params(command=f"cat {temp_work_dir}/test_file.txt"))
    assert not result.is_error
    assert result.output == snapshot("Test content\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_text_processing(shell_tool: Shell):
    """Test text processing commands."""
    result = await shell_tool(Params(command="echo 'apple banana cherry' | sed 's/banana/orange/'"))
    assert not result.is_error
    assert result.output == snapshot("apple orange cherry\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_command_substitution(shell_tool: Shell):
    """Test command substitution with a portable command."""
    result = await shell_tool(Params(command='echo "Result: $(echo hello)"'))
    assert not result.is_error
    assert result.output == snapshot("Result: hello\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_arithmetic_substitution(shell_tool: Shell):
    """Test arithmetic substitution - more portable than date command."""
    result = await shell_tool(Params(command='echo "Answer: $((2 + 2))"'))
    assert not result.is_error
    assert result.output == snapshot("Answer: 4\n")
    assert result.message == snapshot("Command executed successfully.")


async def test_very_long_output(shell_tool: Shell):
    """Test command that produces very long output."""
    result = await shell_tool(Params(command="seq 1 100 | head -50"))

    assert not result.is_error
    assert isinstance(result.output, str)
    assert "1" in result.output
    assert "50" in result.output
    assert "51" not in result.output  # Should not contain 51


async def test_output_truncation_on_success(shell_tool: Shell):
    """Test that very long output gets truncated on successful command."""
    # Generate output longer than MAX_OUTPUT_LENGTH
    oversize_length = DEFAULT_MAX_CHARS + 1000
    result = await shell_tool(Params(command=f"python3 -c \"print('X' * {oversize_length})\""))

    assert not result.is_error
    assert isinstance(result.output, str)
    # Check if output was truncated (it should be)
    if len(result.output) > DEFAULT_MAX_CHARS:
        assert result.output.endswith("[...truncated]\n")
        assert "Output is truncated" in result.message
    assert "Command executed successfully" in result.message


async def test_output_truncation_on_failure(shell_tool: Shell):
    """Test that very long output gets truncated even when command fails."""
    # Generate long output with a command that will fail
    result = await shell_tool(
        Params(command="python3 -c \"import sys; print('ERROR_' * 8000); sys.exit(1)\"")
    )

    assert result.is_error
    assert isinstance(result.output, str)
    # Check if output was truncated
    if len(result.output) > DEFAULT_MAX_CHARS:
        assert result.output.endswith("[...truncated]\n")
        assert "Output is truncated" in result.message
    assert "Command failed with exit code:" in result.message


async def test_timeout_parameter_validation_bounds(shell_tool: Shell):
    """Test timeout parameter validation (bounds checking)."""
    # Test timeout < 1 (should fail validation)
    with pytest.raises(ValueError, match="timeout"):
        Params(command="echo test", timeout=0)

    with pytest.raises(ValueError, match="timeout"):
        Params(command="echo test", timeout=-1)

    # Test timeout > MAX_BACKGROUND_TIMEOUT (should fail validation)
    from kimi_cli.tools.shell import MAX_BACKGROUND_TIMEOUT, MAX_FOREGROUND_TIMEOUT

    with pytest.raises(ValueError, match="timeout"):
        Params(command="echo test", timeout=MAX_BACKGROUND_TIMEOUT + 1)

    # Test foreground timeout > MAX_FOREGROUND_TIMEOUT (should fail validation)
    with pytest.raises(ValueError, match="foreground"):
        Params(command="echo test", timeout=MAX_FOREGROUND_TIMEOUT + 1)

    # Background commands can use longer timeouts
    params = Params(
        command="make build",
        timeout=MAX_FOREGROUND_TIMEOUT + 1,
        run_in_background=True,
        description="long build",
    )
    assert params.timeout == MAX_FOREGROUND_TIMEOUT + 1


async def test_shell_works_in_plan_mode(shell_tool: Shell, runtime):
    """Shell should still work in plan mode — plan mode constraints are enforced by
    the dynamic injection prompt, not by hard-blocking the tool."""
    runtime.session.state.plan_mode = True

    result = await shell_tool(Params(command="echo plan_ok"))

    assert not result.is_error
    assert "plan_ok" in result.output


async def test_cancelled_command_kills_process(shell_tool: Shell, monkeypatch: pytest.MonkeyPatch):
    """Test that cancelling a shell run kills the underlying process."""

    started = asyncio.Event()

    class BlockingReadable:
        async def readline(self) -> bytes:
            started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    class FakeStdin:
        def close(self) -> None:
            pass

    class FakeProcess:
        def __init__(self) -> None:
            self.stdin = FakeStdin()
            self.stdout = BlockingReadable()
            self.stderr = BlockingReadable()
            self.kill_calls = 0

        async def wait(self) -> int:
            return 0

        async def kill(self) -> None:
            self.kill_calls += 1

    fake_process = FakeProcess()

    async def fake_exec(*_args, **_kwargs) -> FakeProcess:
        return fake_process

    monkeypatch.setattr("kimi_cli.tools.shell.kaos.exec", fake_exec)

    task = asyncio.create_task(
        shell_tool._run_shell_command("sleep 10", lambda _line: None, lambda _line: None, 60)
    )
    await asyncio.wait_for(started.wait(), timeout=1.0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert fake_process.kill_calls == 1
