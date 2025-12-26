from __future__ import annotations

import asyncio
import os
import platform
import stat
from collections.abc import AsyncGenerator
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

import asyncssh
import pytest
import pytest_asyncio

from kaos import reset_current_kaos, set_current_kaos
from kaos.path import KaosPath
from kaos.ssh import SSHKaos

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(platform.system() == "Windows", reason="SSH tests run only on non-Windows."),
]


@pytest.fixture(scope="module")
def ssh_kaos_config() -> dict[str, Any]:
    """Collect SSH connection parameters from environment variables."""
    host = os.environ.get("KAOS_SSH_HOST", "127.0.0.1")
    username = os.environ.get("KAOS_SSH_USERNAME")

    config: dict[str, Any] = {
        "host": host,
        "port": int(os.environ.get("KAOS_SSH_PORT", "22")),
        "username": username,
    }

    password = os.environ.get("KAOS_SSH_PASSWORD")
    if password:
        config["password"] = password

    key_paths = os.environ.get("KAOS_SSH_KEY_PATHS")
    if key_paths:
        config["key_paths"] = [path for path in key_paths.split(",") if path]

    key_contents = os.environ.get("KAOS_SSH_KEY_CONTENTS")
    if key_contents:
        config["key_contents"] = [content for content in key_contents.split("|||") if content]

    return config


@pytest_asyncio.fixture
async def ssh_kaos(ssh_kaos_config: dict[str, Any]) -> AsyncGenerator[SSHKaos]:
    """Create a shared SSH KAOS instance for integration tests."""
    try:
        kaos = await SSHKaos.create(**ssh_kaos_config)
    except (OSError, asyncssh.Error) as exc:
        pytest.skip(f"SSH connection failed: {exc}")

    try:
        yield kaos
    finally:
        await kaos.unsafe_close()


@pytest_asyncio.fixture
async def remote_base(ssh_kaos: SSHKaos) -> AsyncGenerator[str]:
    """Create and clean up an isolated remote directory for each test."""
    base = ssh_kaos.gethome().joinpath(f".pykaos_test_{os.getpid()}_{uuid4().hex}")
    base_str = str(base)

    await ssh_kaos.mkdir(base_str, parents=True, exist_ok=True)

    try:
        yield base_str
    finally:
        cleanup = await ssh_kaos.exec("rm", "-rf", base_str)
        await cleanup.wait()
        await ssh_kaos.chdir(ssh_kaos.gethome())


@pytest.fixture
def bind_current_kaos(ssh_kaos: SSHKaos):
    """Bind KAOS globals to the SSH backend for KaosPath helpers."""
    token = set_current_kaos(ssh_kaos)
    try:
        yield ssh_kaos
    finally:
        reset_current_kaos(token)


async def test_pathclass_home_and_cwd(ssh_kaos: SSHKaos):
    home = ssh_kaos.gethome()
    cwd = ssh_kaos.getcwd()

    assert ssh_kaos.pathclass() is PurePosixPath
    assert isinstance(home, KaosPath)
    assert isinstance(cwd, KaosPath)
    assert home.is_absolute()
    assert cwd.is_absolute()
    assert str(home) == str(cwd)


async def test_chdir_updates_real_path(ssh_kaos: SSHKaos, remote_base: str):
    await ssh_kaos.chdir(remote_base)
    assert str(ssh_kaos.getcwd()) == remote_base

    await ssh_kaos.mkdir("child", exist_ok=True)
    await ssh_kaos.chdir("child")
    assert str(ssh_kaos.getcwd()) == os.path.join(remote_base, "child")

    await ssh_kaos.chdir("..")
    assert str(ssh_kaos.getcwd()) == remote_base


async def test_exec_respects_cwd(ssh_kaos: SSHKaos, remote_base: str):
    await ssh_kaos.chdir(remote_base)

    proc = await ssh_kaos.exec("pwd")
    out = (await proc.stdout.read()).decode().strip()
    code = await proc.wait()

    assert code == 0
    assert out == remote_base


async def test_exec_wait_before_read(ssh_kaos: SSHKaos):
    proc = await ssh_kaos.exec("echo", "output")

    exit_code = await proc.wait()
    output = (await proc.stdout.read()).decode().strip()

    assert exit_code == 0
    assert output == "output"


async def test_mkdir_respects_exist_ok(ssh_kaos: SSHKaos, remote_base: str):
    nested_dir = os.path.join(remote_base, "deep", "level")

    await ssh_kaos.mkdir(nested_dir, parents=True, exist_ok=False)

    with pytest.raises(FileExistsError):
        await ssh_kaos.mkdir(nested_dir, exist_ok=False)

    await ssh_kaos.mkdir(nested_dir, parents=True, exist_ok=True)


async def test_stat_reports_directory_and_file_metadata(ssh_kaos: SSHKaos, remote_base: str):
    directory_stat = await ssh_kaos.stat(remote_base, follow_symlinks=False)
    assert stat.S_ISDIR(directory_stat.st_mode)

    file_path = os.path.join(remote_base, "payload.txt")
    payload = "metadata"
    await ssh_kaos.writetext(file_path, payload)

    file_stat = await ssh_kaos.stat(file_path)
    assert stat.S_ISREG(file_stat.st_mode)
    assert file_stat.st_size == len(payload)
    assert file_stat.st_nlink >= 0


async def test_kaospath_roundtrip(bind_current_kaos: SSHKaos, remote_base: str):
    await bind_current_kaos.chdir(remote_base)

    text_path = KaosPath(remote_base) / "text.txt"
    bytes_path = KaosPath(remote_base) / "blob.bin"

    text_payload = "Hello SSH\n"
    appended = "More data\n"
    written = await text_path.write_text(text_payload)
    assert written == len(text_payload)

    appended_len = await text_path.append_text(appended)
    assert appended_len == len(appended)

    full_text = await text_path.read_text()
    assert full_text == text_payload + appended

    lines = [line async for line in text_path.read_lines()]
    assert lines == ["Hello SSH", "More data"]

    bytes_payload = bytes(range(32))
    bytes_written = await bytes_path.write_bytes(bytes_payload)
    assert bytes_written == len(bytes_payload)

    roundtrip = await bytes_path.read_bytes()
    assert roundtrip == bytes_payload

    assert str(KaosPath.cwd()) == remote_base


async def test_iterdir_lists_child_entries(ssh_kaos: SSHKaos, remote_base: str):
    await ssh_kaos.writetext(os.path.join(remote_base, "file1.txt"), "1")
    await ssh_kaos.writetext(os.path.join(remote_base, "file2.log"), "2")
    await ssh_kaos.mkdir(os.path.join(remote_base, "subdir"), exist_ok=True)

    entries = [entry async for entry in ssh_kaos.iterdir(remote_base)]
    names = {entry.name for entry in entries}

    assert names == {"file1.txt", "file2.log", "subdir"}
    assert all(isinstance(entry, KaosPath) for entry in entries)


async def test_glob_is_case_sensitive(ssh_kaos: SSHKaos, remote_base: str):
    await ssh_kaos.writetext(os.path.join(remote_base, "file.log"), "lowercase")
    await ssh_kaos.writetext(os.path.join(remote_base, "FILE.LOG"), "uppercase")

    matches = {str(path) async for path in ssh_kaos.glob(remote_base, "*.log")}
    assert os.path.join(remote_base, "file.log") in matches
    assert os.path.join(remote_base, "FILE.LOG") not in matches

    with pytest.raises(ValueError):
        await anext(ssh_kaos.glob(remote_base, "*.log", case_sensitive=False))


async def test_exec_streams_stdout_and_stderr(ssh_kaos: SSHKaos):
    proc = await ssh_kaos.exec("sh", "-c", "printf 'out\\n' && printf 'err\\n' 1>&2")

    stdout_data, stderr_data = await asyncio.gather(proc.stdout.read(), proc.stderr.read())
    exit_code = await proc.wait()

    assert proc.returncode == exit_code == 0
    assert stdout_data.decode().strip() == "out"
    assert stderr_data.decode().strip() == "err"


async def test_exec_rejects_empty_command(ssh_kaos: SSHKaos):
    with pytest.raises(ValueError):
        await ssh_kaos.exec()  # type: ignore[misc]


async def test_process_kill_updates_returncode(ssh_kaos: SSHKaos):
    proc = await ssh_kaos.exec("sh", "-c", "echo ready; sleep 30")

    first_line = await proc.stdout.readline()
    assert first_line == b"ready\n"
    assert proc.returncode is None

    await proc.kill()
    exit_code = await proc.wait()

    assert exit_code != 0
    assert proc.returncode == exit_code
    assert proc.pid == -1
