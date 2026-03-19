from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.plugin import (
    PluginError,
    PluginRuntime,
    inject_config,
    parse_plugin_json,
    write_runtime,
)


def _write_plugin(tmp_path: Path, plugin_data: dict) -> Path:
    """Write a plugin.json and return the plugin directory."""
    plugin_dir = tmp_path / plugin_data.get("name", "test-plugin")
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(json.dumps(plugin_data), encoding="utf-8")
    return plugin_dir


def test_parse_minimal_plugin_json(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "my-plugin",
            "version": "1.0.0",
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "my-plugin"
    assert spec.version == "1.0.0"
    assert spec.config_file is None
    assert spec.inject == {}
    assert spec.runtime is None


def test_parse_full_plugin_json(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "stock-assistant",
            "version": "1.0.0",
            "description": "Stock helper",
            "config_file": "config/config.json",
            "inject": {"kimicode.api_key": "api_key"},
        },
    )
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
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "bad-plugin",
            "version": "1.0.0",
            "inject": {"some.key": "api_key"},
        },
    )
    with pytest.raises(PluginError, match="config_file"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_with_runtime(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "installed-plugin",
            "version": "1.0.0",
            "runtime": {"host": "kimi-code", "host_version": "1.22.0"},
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.runtime is not None
    assert spec.runtime.host == "kimi-code"
    assert spec.runtime.host_version == "1.22.0"


def test_parse_plugin_json_missing_version(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text('{"name": "x"}', encoding="utf-8")
    with pytest.raises(PluginError, match="version"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_malformed(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text("{not json}", encoding="utf-8")
    with pytest.raises(PluginError, match="Failed to read"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_inject_config_writes_value(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "config/config.json",
            "inject": {"kimicode.api_key": "api_key"},
        },
    )
    config_dir = plugin_dir / "config"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps({"kimicode": {"api_key": "PLACEHOLDER", "timeout": 30}}),
        encoding="utf-8",
    )

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    inject_config(plugin_dir, spec, {"api_key": "sk-real-key"})

    result = json.loads((config_dir / "config.json").read_text())
    assert result["kimicode"]["api_key"] == "sk-real-key"
    assert result["kimicode"]["timeout"] == 30  # untouched


def test_inject_config_creates_nested_path(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "c.json",
            "inject": {"a.b.c": "api_key"},
        },
    )
    (plugin_dir / "c.json").write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    inject_config(plugin_dir, spec, {"api_key": "val"})

    result = json.loads((plugin_dir / "c.json").read_text())
    assert result["a"]["b"]["c"] == "val"


def test_inject_config_missing_key_raises(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "c.json",
            "inject": {"x": "api_key"},
        },
    )
    (plugin_dir / "c.json").write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="api_key"):
        inject_config(plugin_dir, spec, {})


def test_inject_config_missing_file_raises(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "missing.json",
            "inject": {"x": "api_key"},
        },
    )

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="not found"):
        inject_config(plugin_dir, spec, {"api_key": "v"})


def test_write_runtime(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
        },
    )

    runtime = PluginRuntime(host="kimi-code", host_version="1.22.0")
    write_runtime(plugin_dir, runtime)

    data = json.loads((plugin_dir / "plugin.json").read_text())
    assert data["runtime"]["host"] == "kimi-code"
    assert data["runtime"]["host_version"] == "1.22.0"
    assert data["name"] == "p"  # original fields preserved


def test_inject_config_noop_when_no_inject(tmp_path: Path):
    """inject_config should be a no-op when spec has no inject mappings."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    # Should not raise, even with empty values
    inject_config(plugin_dir, spec, {})


def test_inject_config_rejects_path_traversal(tmp_path: Path):
    """config_file with '..' should be rejected."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "../../etc/passwd",
            "inject": {"x": "api_key"},
        },
    )
    # Create the file so it exists (the guard should trigger before reading)
    target = (plugin_dir / "../../etc/passwd").resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="escapes plugin directory"):
        inject_config(plugin_dir, spec, {"api_key": "v"})


def test_parse_plugin_json_with_tools(tmp_path: Path):
    """Tools should be parsed from plugin.json."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "t",
            "version": "1.0.0",
            "tools": [
                {
                    "name": "my_tool",
                    "description": "does stuff",
                    "command": ["python3", "run.py"],
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert len(spec.tools) == 1
    assert spec.tools[0].name == "my_tool"
    assert spec.tools[0].command == ["python3", "run.py"]


def test_parse_plugin_json_ignores_unknown_fields(tmp_path: Path):
    """Unknown fields should be silently ignored (forward compat)."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "future_field": "whatever",
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "p"
