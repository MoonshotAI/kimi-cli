"""Tests for Environment.detect() and git-bash resolution on Windows."""

from __future__ import annotations

import platform
import subprocess

import pytest
from kaos.path import KaosPath

from kimi_cli.utils.environment import (
    Environment,
    GitBashNotFoundError,
    _find_git_bash_path,
    is_windows,
)


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_linux(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(platform, "version", lambda: "5.15.0-123-generic")

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == "/usr/bin/bash"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.os_kind == "Linux"
    assert env.os_arch == "x86_64"
    assert env.os_version == "5.15.0-123-generic"
    assert env.shell_name == "bash"
    assert str(env.shell_path) == "/usr/bin/bash"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_linux_falls_back_to_sh(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(platform, "version", lambda: "5.15.0")

    async def _mock_is_file(self: KaosPath) -> bool:
        return False  # No bash anywhere

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.shell_name == "sh"
    assert str(env.shell_path) == "/bin/sh"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_with_env_override(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.setenv("KIMI_CLI_GIT_BASH_PATH", r"D:\custom\bash.exe")

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == r"D:\custom\bash.exe"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.os_kind == "Windows"
    assert env.shell_name == "bash"
    assert str(env.shell_path) == r"D:\custom\bash.exe"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_invalid_override_raises(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.setenv("KIMI_CLI_GIT_BASH_PATH", r"D:\nonexistent\bash.exe")

    async def _mock_is_file(self: KaosPath) -> bool:
        return False

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    with pytest.raises(GitBashNotFoundError) as excinfo:
        await Environment.detect()

    assert "KIMI_CLI_GIT_BASH_PATH" in str(excinfo.value)
    assert "D:\\nonexistent\\bash.exe" in str(excinfo.value)


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_via_where_git(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.delenv("KIMI_CLI_GIT_BASH_PATH", raising=False)

    # Simulate where.exe git -> C:\Program Files\Git\cmd\git.exe
    import shutil

    monkeypatch.setattr(
        shutil, "which", lambda exe: r"C:\Program Files\Git\cmd\git.exe" if exe == "git" else None
    )

    expected_bash = r"C:\Program Files\Git\cmd\..\bin\bash.exe"

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == expected_bash

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.shell_name == "bash"
    assert str(env.shell_path) == expected_bash


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_checks_all_where_git_matches(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.delenv("KIMI_CLI_GIT_BASH_PATH", raising=False)

    shim_git = r"C:\Users\me\scoop\shims\git.exe"

    def fake_run(args, **kwargs):
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["check"] is False
        if args == [shim_git, "--exec-path"]:
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="shim failed")
        assert args == ["where.exe", "git"]
        return subprocess.CompletedProcess(
            args,
            0,
            stdout=shim_git + "\n" + r"C:\Program Files\Git\cmd\git.exe" + "\n",
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    expected_bash = r"C:\Program Files\Git\cmd\..\bin\bash.exe"

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == expected_bash

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.shell_name == "bash"
    assert str(env.shell_path) == expected_bash


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_resolves_shim_only_git(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.delenv("KIMI_CLI_GIT_BASH_PATH", raising=False)

    shim_git = r"C:\Users\me\scoop\shims\git.exe"

    def fake_run(args, **kwargs):
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["check"] is False
        if args == ["where.exe", "git"]:
            return subprocess.CompletedProcess(args, 0, stdout=shim_git + "\n", stderr="")
        if args == [shim_git, "--exec-path"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout="C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n",
                stderr="",
            )
        raise AssertionError(f"Unexpected subprocess args: {args!r}")

    monkeypatch.setattr(subprocess, "run", fake_run)

    expected_bash = r"C:\Users\me\scoop\apps\git\current\bin\bash.exe"

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == expected_bash

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.shell_name == "bash"
    assert str(env.shell_path) == expected_bash


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_default_install_location(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.delenv("KIMI_CLI_GIT_BASH_PATH", raising=False)

    import shutil

    # Simulate `where.exe git` returning nothing
    monkeypatch.setattr(shutil, "which", lambda exe: None)

    fallback = r"C:\Program Files\Git\bin\bash.exe"

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == fallback

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    env = await Environment.detect()
    assert env.shell_name == "bash"
    assert str(env.shell_path) == fallback


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_no_git_bash_anywhere(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.delenv("KIMI_CLI_GIT_BASH_PATH", raising=False)

    import shutil

    monkeypatch.setattr(shutil, "which", lambda exe: None)

    async def _mock_is_file(self: KaosPath) -> bool:
        return False

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    with pytest.raises(GitBashNotFoundError) as excinfo:
        await Environment.detect()

    msg = str(excinfo.value)
    assert "Git for Windows" in msg
    assert "KIMI_CLI_GIT_BASH_PATH" in msg


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_find_git_bash_path_directly(monkeypatch):
    """Direct unit test for the helper, without going through Environment.detect()."""
    monkeypatch.setenv("KIMI_CLI_GIT_BASH_PATH", r"E:\git\bash.exe")

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == r"E:\git\bash.exe"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    path = await _find_git_bash_path()
    assert str(path) == r"E:\git\bash.exe"


def test_is_windows_reflects_platform_system(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    assert is_windows() is True
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    assert is_windows() is False
    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    assert is_windows() is False
