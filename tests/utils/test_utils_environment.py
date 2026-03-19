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


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_environment_detection_windows(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.os_kind == "Windows"
    assert env.os_arch == "AMD64"
    assert env.os_version == "10.0.19044"
    assert env.shell_name == "Windows PowerShell"
    assert str(env.shell_path) == "powershell.exe"


async def test_environment_detect_with_custom_shell(monkeypatch):
    """When default_shell is provided, it should override auto-detection."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect(default_shell="/usr/bin/bash")
    assert env.shell_name == "bash"
    assert "bash" in str(env.shell_path)


async def test_environment_detect_custom_shell_empty_falls_back(monkeypatch):
    """Empty default_shell should fall back to auto-detection."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(platform, "version", lambda: "6.1.0")

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == "/bin/bash"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect(default_shell="")
    assert env.shell_name == "bash"
