"""Tests for environment detection utilities."""

import os
import platform
from unittest.mock import AsyncMock

import pytest
from kaos.path import KaosPath

from kimi_cli.config import ShellConfig
from kimi_cli.utils import environment as environment_module


@pytest.fixture(autouse=True)
def reset_environment_cache():
    """Reset any module-level caches before each test."""
    yield


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_environment_detection(monkeypatch):
    """Test basic environment detection on non-Windows systems."""
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
    """Test basic environment detection on Windows without config - uses real system state.

    Note: This test verifies that the detection works with the actual system configuration.
    If Git Bash is installed and SHELL is set, bash will be detected.
    If not, PowerShell will be used as fallback.
    """
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(platform, "version", lambda: "10.0.19044")

    # Remove SHELL env var to test fallback behavior
    monkeypatch.delenv("SHELL", raising=False)

    # Mock out all bash paths so no bash is found
    async def _mock_is_file_no_bash(self: KaosPath) -> bool:
        return False

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file_no_bash)

    from kimi_cli.utils.environment import Environment

    env = await Environment.detect()
    assert env.os_kind == "Windows"
    assert env.os_arch == "AMD64"
    assert env.os_version == "10.0.19044"
    assert env.shell_name == "Windows PowerShell"
    assert str(env.shell_path) == "powershell.exe"


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_config_path_explicit(monkeypatch):
    """Test Windows shell detection with explicit config path."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.delenv("SHELL", raising=False)

    async def _mock_is_file(self: KaosPath) -> bool:
        return "Git/bin/bash.exe" in str(self).replace("\\", "/")

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    config = ShellConfig(path="C:/Program Files/Git/bin/bash.exe")
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "bash"
    assert "bash.exe" in str(shell_path)


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_config_preferred_bash(monkeypatch):
    """Test Windows shell detection with preferred=bash."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.delenv("SHELL", raising=False)

    async def _mock_is_file(self: KaosPath) -> bool:
        return "Git/bin/bash.exe" in str(self).replace("\\", "/")

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    config = ShellConfig(preferred="bash")
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "bash"
    assert "bash.exe" in str(shell_path)


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_config_preferred_powershell(monkeypatch):
    """Test Windows shell detection with preferred=powershell."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.delenv("SHELL", raising=False)

    # Mock out bash detection so it doesn't accidentally find bash
    async def _mock_is_file(self: KaosPath) -> bool:
        return False

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    config = ShellConfig(preferred="powershell")
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "Windows PowerShell"
    assert str(shell_path) == "powershell.exe"


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_env_var_shell(monkeypatch):
    """Test Windows shell detection respects SHELL env var."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")

    async def _mock_is_file(self: KaosPath) -> bool:
        return "custom/bash.exe" in str(self).replace("\\", "/")

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)
    monkeypatch.setenv("SHELL", "C:/custom/bash.exe")

    config = ShellConfig()  # default auto
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "bash"
    assert "custom" in str(shell_path) and "bash.exe" in str(shell_path)


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_config_path_takes_precedence_over_env(monkeypatch):
    """Test that config.path takes precedence over SHELL env var."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")

    async def _mock_is_file(self: KaosPath) -> bool:
        path_str = str(self).replace("\\", "/")
        return "Git/bin/bash.exe" in path_str or "env/bash.exe" in path_str

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)
    monkeypatch.setenv("SHELL", "C:/env/bash.exe")

    config = ShellConfig(path="C:/Program Files/Git/bin/bash.exe")
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "bash"
    assert "Git" in str(shell_path) and "bash.exe" in str(shell_path)


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_fallback_when_explicit_path_missing(monkeypatch):
    """Test fallback to PowerShell when explicit path doesn't exist."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.delenv("SHELL", raising=False)

    async def _mock_is_file(self: KaosPath) -> bool:
        return False  # No bash found

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    config = ShellConfig(path="C:/NonExistent/bash.exe")
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "Windows PowerShell"
    assert str(shell_path) == "powershell.exe"


@pytest.mark.skipif(platform.system() != "Windows", reason="Skipping test on non-Windows")
async def test_windows_shell_config_path_backslash_normalized(monkeypatch):
    """Test that backslashes in config path are normalized to forward slashes."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.delenv("SHELL", raising=False)

    async def _mock_is_file(self: KaosPath) -> bool:
        return "Git/bin/bash.exe" in str(self).replace("\\", "/")

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    # Use backslashes in path
    config = ShellConfig(path="C:\\Program Files\\Git\\bin\\bash.exe")
    shell_name, shell_path = await environment_module.Environment._determine_windows_shell(config)

    assert shell_name == "bash"
    # Path normalization converts backslashes to forward slashes for KaosPath
    assert "bash.exe" in str(shell_path)


def test_infer_shell_name():
    """Test shell name inference from path."""
    assert environment_module.Environment._infer_shell_name("/bin/bash") == "bash"
    assert environment_module.Environment._infer_shell_name("/usr/bin/bash") == "bash"
    assert environment_module.Environment._infer_shell_name("C:/Program Files/Git/bin/bash.exe") == "bash"
    assert environment_module.Environment._infer_shell_name("powershell.exe") == "Windows PowerShell"
    assert (
        environment_module.Environment._infer_shell_name(
            "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        )
        == "Windows PowerShell"
    )
    assert environment_module.Environment._infer_shell_name("pwsh") == "Windows PowerShell"
    assert environment_module.Environment._infer_shell_name("/bin/zsh") == "zsh"
    assert environment_module.Environment._infer_shell_name("/usr/bin/zsh") == "zsh"
    assert environment_module.Environment._infer_shell_name("/bin/fish") == "fish"
    assert environment_module.Environment._infer_shell_name("/bin/sh") == "sh"
    assert environment_module.Environment._infer_shell_name("/unknown/shell") == "sh"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_unix_shell_config_path_explicit(monkeypatch):
    """Test Unix shell detection with explicit config path."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.delenv("SHELL", raising=False)

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == "/custom/zsh"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    config = ShellConfig(path="/custom/zsh")
    shell_name, shell_path = await environment_module.Environment._determine_unix_shell(config)

    assert shell_name == "zsh"
    assert str(shell_path) == "/custom/zsh"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_unix_shell_env_var(monkeypatch):
    """Test Unix shell detection respects SHELL env var."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")

    async def _mock_is_file(self: KaosPath) -> bool:
        return str(self) == "/usr/bin/zsh"

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)
    monkeypatch.setenv("SHELL", "/usr/bin/zsh")

    config = ShellConfig()
    shell_name, shell_path = await environment_module.Environment._determine_unix_shell(config)

    assert shell_name == "zsh"
    assert str(shell_path) == "/usr/bin/zsh"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_unix_shell_fallback_to_sh(monkeypatch):
    """Test Unix shell fallback to sh when no bash found."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.delenv("SHELL", raising=False)

    async def _mock_is_file(self: KaosPath) -> bool:
        return False  # No bash found

    monkeypatch.setattr(KaosPath, "is_file", _mock_is_file)

    config = ShellConfig()
    shell_name, shell_path = await environment_module.Environment._determine_unix_shell(config)

    assert shell_name == "sh"
    assert str(shell_path) == "/bin/sh"
