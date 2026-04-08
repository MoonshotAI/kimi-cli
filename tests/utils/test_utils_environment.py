import os
import platform

import pytest
from kaos.path import KaosPath


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(platform, "version", lambda: "5.15.0-123-generic")

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == "/usr/bin/bash"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.os_kind == "Linux"
    assert env.os_arch == "x86_64"
    assert env.os_version == "5.15.0-123-generic"
    assert env.shell_name == "bash"
    assert str(env.shell_path) == "/usr/bin/bash"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")
    monkeypatch.delenv("ProgramW6432", raising=False)
    monkeypatch.setattr("kimi_cli.utils.environment.shutil.which", lambda *_a, **_k: None)

    expected = os.path.join(
        r"C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    )

    async def _mock_is_file(self: KaosPath) -> bool:
        return os.path.normcase(str(self)) == os.path.normcase(expected)

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.os_kind == "Windows"
    assert env.os_arch == "AMD64"
    assert env.os_version == "10.0.19044"
    assert env.shell_name == "Windows PowerShell"
    assert os.path.normcase(str(env.shell_path)) == os.path.normcase(expected)


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_prefers_pwsh_from_path(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")
    expected = os.path.join(r"C:\Program Files", "PowerShell", "7", "pwsh.exe")

    def _which(cmd: str, path: str | None = None) -> str | None:
        if cmd == "pwsh":
            return expected
        return None

    monkeypatch.setattr("kimi_cli.utils.environment.shutil.which", _which)

    async def _mock_is_file(self: KaosPath) -> bool:
        return os.path.normcase(str(self)) == os.path.normcase(expected)

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.shell_name == "Windows PowerShell"
    assert os.path.normcase(str(env.shell_path)) == os.path.normcase(expected)


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_prefers_pwsh_from_program_files(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")
    monkeypatch.delenv("ProgramW6432", raising=False)
    monkeypatch.setenv("ProgramFiles", r"C:\Program Files")
    monkeypatch.setattr("kimi_cli.utils.environment.shutil.which", lambda *_a, **_k: None)

    expected = os.path.join(r"C:\Program Files", "PowerShell", "7", "pwsh.exe")

    async def _mock_is_file(self: KaosPath) -> bool:
        return os.path.normcase(str(self)) == os.path.normcase(expected)

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.shell_name == "Windows PowerShell"
    assert os.path.normcase(str(env.shell_path)) == os.path.normcase(expected)


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection_windows_fallback(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")
    monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")
    monkeypatch.setattr("kimi_cli.utils.environment.shutil.which", lambda *_a, **_k: None)

    async def _mock_is_file(self: KaosPath) -> bool:
        return False

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.os_kind == "Windows"
    assert env.os_arch == "AMD64"
    assert env.os_version == "10.0.19044"
    assert env.shell_name == "Windows PowerShell"
    assert str(env.shell_path) == "powershell.exe"
