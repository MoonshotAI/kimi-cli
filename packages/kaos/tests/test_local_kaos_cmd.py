"""Tests for `kaos.exec` running commands via cmd.exe /c."""

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
    platform.system() != "Windows", reason="cmd.exe tests run only on Windows."
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


async def run_cmd(command: str) -> tuple[int, str, str]:
    """Execute a cmd.exe command through kaos.exec and collect exit code and streams."""
    process = await kaos.exec("cmd.exe", "/c", f"chcp 65001>nul & {command}")
    assert process.stdout is not None
    assert process.stderr is not None

    stdout_task = asyncio.create_task(process.stdout.read())
    stderr_task = asyncio.create_task(process.stderr.read())
    exit_code = await process.wait()
    stdout_data, stderr_data = await asyncio.gather(stdout_task, stderr_task)
    return exit_code, stdout_data.decode("utf-8"), stderr_data.decode("utf-8")


@pytest.mark.asyncio
async def test_simple_command():
    """Ensure a basic cmd.exe command runs."""
    exit_code, stdout, stderr = await run_cmd("echo Hello Windows")

    assert exit_code == 0
    assert stdout.strip() == snapshot("Hello Windows")
    assert stderr == snapshot("")


@pytest.mark.asyncio
async def test_command_with_error():
    """Failing commands should return a non-zero exit code."""
    exit_code, stdout, stderr = await run_cmd("exit /b 1")

    assert exit_code == 1
    assert stdout == snapshot("")
    assert stderr == snapshot("")


@pytest.mark.asyncio
async def test_command_chaining():
    """Chaining commands with && should work."""
    exit_code, stdout, stderr = await run_cmd("echo First&& echo Second")

    assert exit_code == 0
    assert stdout.replace("\r\n", "\n") == snapshot("First\nSecond\n")
    assert stderr == snapshot("")


@pytest.mark.asyncio
async def test_file_operations():
    """Basic file write/read using cmd redirection."""
    file_path = Path("test_file.txt")
    exit_code, stdout, stderr = await run_cmd(f"echo Test content> {file_path}")
    assert exit_code == 0
    assert stdout == snapshot("")
    assert stderr == snapshot("")
    assert file_path.is_file()

    exit_code, stdout, stderr = await run_cmd(f"type {file_path}")
    assert exit_code == 0
    assert stdout == snapshot("Test content\r\n")
    assert stderr == snapshot("")
