from pathlib import Path

from kimi_cli.utils import environment


def test_collect_environment_context_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("COMSPEC", "C:/Windows/System32/cmd.exe")
    monkeypatch.setattr(environment.platform, "system", lambda: "Windows", raising=False)
    monkeypatch.setattr(environment.platform, "version", lambda: "11", raising=False)
    monkeypatch.setattr(environment.platform, "machine", lambda: "x86_64", raising=False)
    ctx = environment.collect_environment_context(tmp_path)

    summary = ctx.as_prompt()
    assert "Windows 11" in summary
    assert "cmd.exe" in summary
    assert summary.splitlines() == [
        "- OS: Windows 11 (x86_64)",
        "- Shell: C:/Windows/System32/cmd.exe",
    ]


def test_collect_environment_context_posix_default_shell(monkeypatch):
    monkeypatch.delenv("SHELL", raising=False)
    monkeypatch.setattr(environment.os, "name", "posix", raising=False)
    monkeypatch.setattr(environment.platform, "system", lambda: "Linux", raising=False)
    monkeypatch.setattr(environment.platform, "version", lambda: "6.0", raising=False)
    monkeypatch.setattr(environment.platform, "machine", lambda: "arm64", raising=False)

    ctx = environment.collect_environment_context(Path("/tmp"))
    assert ctx.shell == "/bin/sh"
    assert ctx.os_name == "Linux"
    assert ctx.os_version == "6.0"
    assert ctx.machine == "arm64"


def test_format_environment_context_returns_prompt(monkeypatch, tmp_path):
    monkeypatch.setattr(environment.platform, "system", lambda: "TestOS", raising=False)
    monkeypatch.setattr(environment.platform, "version", lambda: "1.0", raising=False)
    monkeypatch.setattr(environment.platform, "machine", lambda: "amd64", raising=False)
    monkeypatch.setattr(environment.os, "name", "posix", raising=False)
    monkeypatch.setenv("SHELL", "/bin/zsh")

    ctx, prompt = environment.format_environment_context(tmp_path)
    assert prompt == ctx.as_prompt()
    assert prompt.splitlines() == [
        "- OS: TestOS 1.0 (amd64)",
        "- Shell: /bin/zsh",
    ]
