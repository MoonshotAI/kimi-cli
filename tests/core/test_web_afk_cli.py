from __future__ import annotations

import os

from typer.testing import CliRunner

from kimi_cli.cli import cli
from kimi_cli.web.app import ENV_DEFAULT_AFK


def test_root_afk_flag_marks_web_sessions_afk(monkeypatch):
    calls: list[dict] = []

    def fake_run_web_server(**kwargs):
        calls.append(kwargs)

    monkeypatch.delenv(ENV_DEFAULT_AFK, raising=False)
    monkeypatch.setattr("kimi_cli.web.app.run_web_server", fake_run_web_server)

    result = CliRunner().invoke(cli, ["--afk", "web", "--no-open"])

    assert result.exit_code == 0, result.output
    assert os.environ[ENV_DEFAULT_AFK] == "1"
    assert calls[0]["open_browser"] is False
