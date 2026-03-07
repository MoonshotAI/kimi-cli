import platform

import pytest
from kaos.path import KaosPath

from kimi_cli.auth.oauth import _ascii_header_value, _common_headers


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


def test_ascii_header_value_strips_ascii_whitespace():
    assert _ascii_header_value("  value  ") == "value"
    assert _ascii_header_value("   ") == "unknown"


def test_common_headers_strip_os_version(monkeypatch):
    monkeypatch.setattr(platform, "node", lambda: "host")
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(platform, "release", lambda: "6.8.0-101-generic")
    monkeypatch.setattr(
        platform,
        "version",
        lambda: "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC Wed Feb 11 13:19:54 UTC ",
    )
    monkeypatch.setattr("kimi_cli.auth.oauth.get_device_id", lambda: "device-id")

    headers = _common_headers()

    assert (
        headers["X-Msh-Os-Version"]
        == "#101~22.04.1-Ubuntu SMP PREEMPT_DYNAMIC Wed Feb 11 13:19:54 UTC"
    )
