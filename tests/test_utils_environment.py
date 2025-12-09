import platform

import pytest


@pytest.mark.asyncio
@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(platform, "version", lambda: "5.15.0-123-generic")

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.os_kind == "Linux"
    assert env.os_arch == "x86_64"
    assert env.os_version == "5.15.0-123-generic"
    assert env.shell_name == "bash"
    assert str(env.shell_path) == "/bin/bash"


@pytest.mark.asyncio
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
