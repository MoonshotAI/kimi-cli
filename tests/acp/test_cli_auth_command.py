from __future__ import annotations

from typer.testing import CliRunner

from kimi_cli.cli import cli


def test_acp_login_delegates_to_top_level_login(monkeypatch):
    called: list[bool] = []

    def fake_login(*, json: bool = False) -> None:
        called.append(json)

    monkeypatch.setattr("kimi_cli.cli.login", fake_login)

    result = CliRunner().invoke(cli, ["acp", "login"])

    assert result.exit_code == 0
    assert called == [False]
