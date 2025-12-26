"""Tests for `kaos.exec` running commands via /bin/sh -c."""

from __future__ import annotations

import asyncio
import os
import platform
from collections.abc import Generator
from pathlib import Path

import pytest
from inline_snapshot import snapshot

import kaos
from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos

pytestmark = pytest.mark.skipif(
    platform.system() == "Windows", reason="/bin/sh is not available on Windows."
)


@pytest.fixture(autouse=True)
def local_kaos(tmp_path: Path) -> Generator[LocalKaos]:
    """Set LocalKaos as current KAOS and isolate cwd per test."""
    local = LocalKaos()
    token = set_current_kaos(local)
    old_cwd = Path.cwd()
    os.chdir(tmp_path)
    try:
        yield local
    finally:
        os.chdir(old_cwd)
        reset_current_kaos(token)


async def run_sh(
    command: str, *, timeout: float | None = None, stdin_data: str | bytes | None = None
) -> tuple[int, str, str]:
    """Execute a shell command through kaos.exec and collect exit code and streams."""
    process = await kaos.exec("/bin/sh", "-c", command)
    stdout_task = asyncio.create_task(process.stdout.read())
    stderr_task = asyncio.create_task(process.stderr.read())

    if stdin_data is not None:
        input_bytes = stdin_data.encode("utf-8") if isinstance(stdin_data, str) else stdin_data
        process.stdin.write(input_bytes)
        await process.stdin.drain()
        process.stdin.close()
        if hasattr(process.stdin, "wait_closed"):
            await process.stdin.wait_closed()

    try:
        wait_coro = process.wait()
        exit_code = (
            await asyncio.wait_for(wait_coro, timeout=timeout) if timeout else await wait_coro
        )
    except TimeoutError:
        await process.kill()
        await process.wait()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        raise

    stdout_data, stderr_data = await asyncio.gather(stdout_task, stderr_task)
    return exit_code, stdout_data.decode("utf-8"), stderr_data.decode("utf-8")


async def test_simple_command():
    """Test executing a simple command."""
    exit_code, stdout, stderr = await run_sh("echo 'Hello World'")
    assert exit_code == 0
    assert stdout == snapshot("Hello World\n")
    assert stderr == snapshot("")


async def test_command_with_error():
    """Test executing a command that returns an error."""
    exit_code, stdout, stderr = await run_sh("ls /nonexistent/directory")
    assert exit_code != 0
    assert stdout == snapshot("")
    assert "No such file or directory" in stderr


async def test_command_chaining():
    """Test command chaining with &&."""
    exit_code, stdout, stderr = await run_sh("echo 'First' && echo 'Second'")
    assert exit_code == 0
    assert stdout == snapshot("""\
First
Second
""")
    assert stderr == snapshot("")


async def test_command_sequential():
    """Test sequential command execution with ;."""
    exit_code, stdout, stderr = await run_sh("echo 'One'; echo 'Two'")
    assert exit_code == 0
    assert stdout == snapshot("""\
One
Two
""")
    assert stderr == snapshot("")


async def test_command_conditional():
    """Test conditional command execution with ||."""
    exit_code, stdout, stderr = await run_sh("false || echo 'Success'")
    assert exit_code == 0
    assert stdout == snapshot("Success\n")
    assert stderr == snapshot("")


async def test_command_pipe():
    """Test command piping."""
    exit_code, stdout, stderr = await run_sh("echo 'Hello World' | wc -w")
    assert exit_code == 0
    assert stdout.strip() == snapshot("2")
    assert stderr == snapshot("")


async def test_multiple_pipes():
    """Test multiple pipes in one command."""
    exit_code, stdout, stderr = await run_sh("printf '1\\n2\\n3\\n' | grep '2' | wc -l")
    assert exit_code == 0
    assert stdout.strip() == snapshot("1")
    assert stderr == snapshot("")


async def test_command_with_timeout():
    """Test command execution with an upper bound on runtime."""
    exit_code, stdout, stderr = await run_sh("sleep 0.1", timeout=1)
    assert exit_code == 0
    assert stdout == snapshot("")
    assert stderr == snapshot("")


async def test_command_timeout_expires():
    """Test command that times out."""
    with pytest.raises(TimeoutError):
        await run_sh("sleep 2", timeout=0.1)


async def test_environment_variables():
    """Test setting and using environment variables."""
    exit_code, stdout, stderr = await run_sh(
        "TEST_VAR='test_value'; export TEST_VAR; echo \"$TEST_VAR\""
    )
    assert exit_code == 0
    assert stdout == snapshot("test_value\n")
    assert stderr == snapshot("")


async def test_file_operations():
    """Test basic file operations."""
    exit_code, stdout, stderr = await run_sh("echo 'Test content' > test_file.txt")
    assert exit_code == 0
    assert stdout == snapshot("")
    assert stderr == snapshot("")

    assert (Path.cwd() / "test_file.txt").is_file()

    exit_code, stdout, stderr = await run_sh("cat test_file.txt")
    assert exit_code == 0
    assert stdout == snapshot("Test content\n")
    assert stderr == snapshot("")


async def test_text_processing():
    """Test text processing commands."""
    exit_code, stdout, stderr = await run_sh("echo 'apple banana cherry' | sed 's/banana/orange/'")
    assert exit_code == 0
    assert stdout == snapshot("apple orange cherry\n")
    assert stderr == snapshot("")


async def test_command_substitution():
    """Test command substitution with a portable command."""
    exit_code, stdout, stderr = await run_sh('echo "Result: $(echo hello)"')
    assert exit_code == 0
    assert stdout == snapshot("Result: hello\n")
    assert stderr == snapshot("")


async def test_arithmetic_substitution():
    """Test arithmetic substitution - more portable than date command."""
    exit_code, stdout, stderr = await run_sh('echo "Answer: $((2 + 2))"')
    assert exit_code == 0
    assert stdout == snapshot("Answer: 4\n")
    assert stderr == snapshot("")


async def test_very_long_output():
    """Test command that produces very long output."""
    exit_code, stdout, stderr = await run_sh("seq 1 100 | head -50")

    assert exit_code == 0
    assert "1" in stdout
    assert "50" in stdout
    assert "51" not in stdout
    assert stderr == snapshot("")


async def test_command_reads_stdin():
    """Test passing data to stdin."""
    exit_code, stdout, stderr = await run_sh(
        "read value; printf '%s\\n' \"$value\"",
        stdin_data="from stdin\n",
    )
    assert exit_code == 0
    assert stdout == snapshot("from stdin\n")
    assert stderr == snapshot("")


async def test_command_reads_multiple_lines_from_stdin():
    """Test reading multiple lines through stdin."""
    exit_code, stdout, stderr = await run_sh(
        "count=0; while IFS= read -r _; do count=$((count+1)); done; printf '%s\\n' \"$count\"",
        stdin_data="alpha\nbeta\ngamma\n",
    )
    assert exit_code == 0
    assert stdout.strip() == snapshot("3")
    assert stderr == snapshot("")
