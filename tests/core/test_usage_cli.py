from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from typer.testing import CliRunner

from kimi_cli.cli import cli
from kimi_cli.ui.shell import usage as shell_usage


def _write_kimi_code_config(path: Path) -> None:
    path.write_text(
        """
default_model = "kimi-code/kimi-k2"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "test-key"

[models."kimi-code/kimi-k2"]
provider = "managed:kimi-code"
model = "kimi-k2"
max_context_size = 262144
""".lstrip(),
        encoding="utf-8",
    )


def test_usage_json_fetches_quota_for_configured_kimi_code_model(
    tmp_path: Path, monkeypatch
) -> None:
    config_file = tmp_path / "config.toml"
    _write_kimi_code_config(config_file)
    payload = {"usage": {"limit": 100, "remaining": 75}}
    observed: dict[str, str] = {}

    async def fake_fetch_usage(url: str, api_key: str) -> Mapping[str, Any]:
        observed["url"] = url
        observed["api_key"] = api_key
        return payload

    monkeypatch.setattr(shell_usage, "fetch_usage", fake_fetch_usage)

    result = CliRunner().invoke(cli, ["--config-file", str(config_file), "usage", "--json"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == payload
    assert observed == {
        "url": "https://api.kimi.com/coding/v1/usages",
        "api_key": "test-key",
    }


def test_usage_renders_interactive_usage_panel_non_interactively(
    tmp_path: Path, monkeypatch
) -> None:
    config_file = tmp_path / "config.toml"
    _write_kimi_code_config(config_file)

    async def fake_fetch_usage(url: str, api_key: str) -> Mapping[str, Any]:
        return {"usage": {"limit": 100, "remaining": 75}}

    monkeypatch.setattr(shell_usage, "fetch_usage", fake_fetch_usage)

    result = CliRunner().invoke(cli, ["--config-file", str(config_file), "usage"])

    assert result.exit_code == 0, result.output
    assert "API Usage" in result.output
    assert "Weekly limit" in result.output
    assert "75% left" in result.output
