from __future__ import annotations

from kimi_cli.ui import shell as shell_module


def test_shell_mode_subprocess_kwargs_uses_shell_env_on_posix(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "posix")
    monkeypatch.setenv("SHELL", "/bin/zsh")

    kwargs = shell_module._shell_mode_subprocess_kwargs(stderr=None)

    assert kwargs == {"executable": "/bin/zsh"}


def test_shell_mode_subprocess_kwargs_keeps_windows_default(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "nt")
    monkeypatch.setenv("SHELL", "/bin/zsh")

    kwargs = shell_module._shell_mode_subprocess_kwargs(stderr="stderr")

    assert kwargs == {"stderr": "stderr"}
