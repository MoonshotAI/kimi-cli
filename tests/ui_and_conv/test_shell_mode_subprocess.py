from __future__ import annotations

from kimi_cli.ui import shell as shell_module


def test_shell_mode_subprocess_kwargs_uses_shell_env_on_posix(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "posix")
    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(shell_module.os.path, "isfile", lambda path: path == "/bin/zsh")
    monkeypatch.setattr(shell_module.os, "access", lambda path, mode: path == "/bin/zsh")

    kwargs = shell_module._shell_mode_subprocess_kwargs(stderr=None)

    assert kwargs == {"executable": "/bin/zsh"}


def test_shell_mode_subprocess_kwargs_ignores_missing_shell_env_path(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "posix")
    monkeypatch.setenv("SHELL", "/stale/bin/zsh")
    monkeypatch.setattr(shell_module.os.path, "isfile", lambda path: False)

    kwargs = shell_module._shell_mode_subprocess_kwargs(stderr=None)

    assert kwargs == {}


def test_shell_mode_subprocess_kwargs_keeps_windows_default(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "nt")
    monkeypatch.setenv("SHELL", "/bin/zsh")

    kwargs = shell_module._shell_mode_subprocess_kwargs(stderr="stderr")

    assert kwargs == {"stderr": "stderr"}
