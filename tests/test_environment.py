from kimi_cli.utils import environment


def test_collect_environment_context(monkeypatch, tmp_path):
    monkeypatch.setenv("COMSPEC", "C:/Windows/System32/cmd.exe")
    monkeypatch.setattr(environment.platform, "system", lambda: "Windows", raising=False)
    monkeypatch.setattr(environment.platform, "version", lambda: "11", raising=False)
    monkeypatch.setattr(environment.platform, "machine", lambda: "x86_64", raising=False)
    ctx = environment.collect_environment_context(tmp_path)

    summary = ctx.as_prompt()
    assert "Windows 11" in summary
    assert "cmd.exe" in summary
    lines = summary.splitlines()
    assert lines == [
        "- OS: Windows 11 (x86_64)",
        "- Shell: C:/Windows/System32/cmd.exe",
    ]
