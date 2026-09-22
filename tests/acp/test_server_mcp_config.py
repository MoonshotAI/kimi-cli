"""Unit tests for ACPServer MCP config assembly.

Regression coverage for the ``kimi acp`` server ignoring the globally-configured
MCP servers (``<share>/mcp.json``) that interactive ``kimi`` loads.
"""

from __future__ import annotations

import json
from pathlib import Path

from kimi_cli.acp.server import ACPServer, _load_global_mcp_config


def _write_global_config(mcp_file: Path, servers: dict) -> None:
    mcp_file.write_text(json.dumps({"mcpServers": servers}), encoding="utf-8")


def test_load_global_mcp_config_missing_file(tmp_path: Path, monkeypatch) -> None:
    missing = tmp_path / "mcp.json"
    monkeypatch.setattr("kimi_cli.cli.mcp.get_global_mcp_config_file", lambda: missing)
    assert _load_global_mcp_config() is None


def test_load_global_mcp_config_malformed_is_ignored(tmp_path: Path, monkeypatch) -> None:
    mcp_file = tmp_path / "mcp.json"
    mcp_file.write_text("{ not valid json", encoding="utf-8")
    monkeypatch.setattr("kimi_cli.cli.mcp.get_global_mcp_config_file", lambda: mcp_file)
    # A broken global config must not raise; it is skipped.
    assert _load_global_mcp_config() is None


def test_build_mcp_configs_includes_global_servers(tmp_path: Path, monkeypatch) -> None:
    mcp_file = tmp_path / "mcp.json"
    _write_global_config(mcp_file, {"fs-test": {"command": "python", "args": ["-c", "pass"]}})
    monkeypatch.setattr("kimi_cli.cli.mcp.get_global_mcp_config_file", lambda: mcp_file)

    configs = ACPServer()._build_mcp_configs(None)

    server_names = {name for config in configs for name in config.mcpServers}
    assert "fs-test" in server_names


def test_build_mcp_configs_without_global_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "kimi_cli.cli.mcp.get_global_mcp_config_file",
        lambda: tmp_path / "does-not-exist.json",
    )
    # No global config on disk and no client-provided servers -> no MCP servers.
    configs = ACPServer()._build_mcp_configs(None)
    server_names = {name for config in configs for name in config.mcpServers}
    assert server_names == set()
