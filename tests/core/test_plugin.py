from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.plugin import PluginSpec, parse_plugin_json, PluginError


def _write_plugin(tmp_path: Path, plugin_data: dict) -> Path:
    """Write a plugin.json and return the plugin directory."""
    plugin_dir = tmp_path / plugin_data.get("name", "test-plugin")
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(json.dumps(plugin_data), encoding="utf-8")
    return plugin_dir


def test_parse_minimal_plugin_json(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "my-plugin",
        "version": "1.0.0",
    })
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "my-plugin"
    assert spec.version == "1.0.0"
    assert spec.config_file is None
    assert spec.inject == {}
    assert spec.runtime is None


def test_parse_full_plugin_json(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "stock-assistant",
        "version": "1.0.0",
        "description": "Stock helper",
        "config_file": "config/config.json",
        "inject": {"kimicode.api_key": "api_key"},
    })
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "stock-assistant"
    assert spec.config_file == "config/config.json"
    assert spec.inject == {"kimicode.api_key": "api_key"}


def test_parse_plugin_json_missing_name(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text('{"version": "1.0.0"}', encoding="utf-8")
    with pytest.raises(PluginError, match="name"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_inject_requires_config_file(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "bad-plugin",
        "version": "1.0.0",
        "inject": {"some.key": "api_key"},
    })
    with pytest.raises(PluginError, match="config_file"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_with_runtime(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "installed-plugin",
        "version": "1.0.0",
        "runtime": {"host": "kimi-code", "host_version": "1.22.0"},
    })
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.runtime is not None
    assert spec.runtime.host == "kimi-code"
    assert spec.runtime.host_version == "1.22.0"
