from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.plugin import PluginError
from kimi_cli.plugin.manager import (
    install_plugin,
    list_plugins,
    remove_plugin,
)


def _make_source_plugin(tmp_path: Path, name: str = "test-plugin") -> Path:
    """Create a minimal valid plugin source directory."""
    src = tmp_path / "source" / name
    src.mkdir(parents=True)
    (src / "plugin.json").write_text(
        json.dumps({
            "name": name,
            "version": "1.0.0",
            "config_file": "config/config.json",
            "inject": {"app.api_key": "api_key"},
        }),
        encoding="utf-8",
    )
    (src / "SKILL.md").write_text(
        "---\nname: test-plugin\ndescription: A test\n---\n# Test",
        encoding="utf-8",
    )
    config_dir = src / "config"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps({"app": {"api_key": "PLACEHOLDER"}}),
        encoding="utf-8",
    )
    return src


def test_install_plugin(tmp_path: Path):
    plugins_dir = tmp_path / "plugins"
    src = _make_source_plugin(tmp_path)

    install_plugin(
        source=src,
        plugins_dir=plugins_dir,
        host_values={"api_key": "sk-real"},
        host_name="kimi-code",
        host_version="1.22.0",
    )

    installed = plugins_dir / "test-plugin"
    assert installed.is_dir()
    assert (installed / "SKILL.md").exists()

    # Check inject
    config = json.loads((installed / "config" / "config.json").read_text())
    assert config["app"]["api_key"] == "sk-real"

    # Check runtime in plugin.json
    pj = json.loads((installed / "plugin.json").read_text())
    assert pj["runtime"]["host"] == "kimi-code"
    assert pj["runtime"]["host_version"] == "1.22.0"


def test_install_plugin_missing_plugin_json(tmp_path: Path):
    src = tmp_path / "source" / "bad"
    src.mkdir(parents=True)

    with pytest.raises(PluginError, match="plugin.json"):
        install_plugin(
            source=src,
            plugins_dir=tmp_path / "plugins",
            host_values={},
            host_name="kimi-code",
            host_version="1.0.0",
        )


def test_install_plugin_rollback_on_failure(tmp_path: Path):
    """If inject fails (missing host key), installed dir should not remain."""
    plugins_dir = tmp_path / "plugins"
    src = _make_source_plugin(tmp_path)

    with pytest.raises(PluginError):
        install_plugin(
            source=src,
            plugins_dir=plugins_dir,
            host_values={},  # missing api_key
            host_name="kimi-code",
            host_version="1.0.0",
        )

    assert not (plugins_dir / "test-plugin").exists()


def test_reinstall_plugin(tmp_path: Path):
    plugins_dir = tmp_path / "plugins"
    src = _make_source_plugin(tmp_path)

    install_plugin(
        source=src,
        plugins_dir=plugins_dir,
        host_values={"api_key": "sk-old"},
        host_name="kimi-code",
        host_version="1.20.0",
    )
    install_plugin(
        source=src,
        plugins_dir=plugins_dir,
        host_values={"api_key": "sk-new"},
        host_name="kimi-code",
        host_version="1.22.0",
    )

    config = json.loads(
        (plugins_dir / "test-plugin" / "config" / "config.json").read_text()
    )
    assert config["app"]["api_key"] == "sk-new"

    pj = json.loads((plugins_dir / "test-plugin" / "plugin.json").read_text())
    assert pj["runtime"]["host_version"] == "1.22.0"


def test_list_plugins(tmp_path: Path):
    plugins_dir = tmp_path / "plugins"
    src = _make_source_plugin(tmp_path, "alpha")

    install_plugin(
        source=src,
        plugins_dir=plugins_dir,
        host_values={"api_key": "k"},
        host_name="kimi-code",
        host_version="1.0.0",
    )

    plugins = list_plugins(plugins_dir)
    assert len(plugins) == 1
    assert plugins[0].name == "alpha"


def test_list_plugins_empty(tmp_path: Path):
    assert list_plugins(tmp_path / "nonexistent") == []


def test_remove_plugin(tmp_path: Path):
    plugins_dir = tmp_path / "plugins"
    src = _make_source_plugin(tmp_path)

    install_plugin(
        source=src,
        plugins_dir=plugins_dir,
        host_values={"api_key": "k"},
        host_name="kimi-code",
        host_version="1.0.0",
    )
    assert (plugins_dir / "test-plugin").exists()

    remove_plugin("test-plugin", plugins_dir)
    assert not (plugins_dir / "test-plugin").exists()


def test_remove_nonexistent_plugin(tmp_path: Path):
    with pytest.raises(PluginError, match="not found"):
        remove_plugin("ghost", tmp_path / "plugins")


@pytest.mark.asyncio
async def test_skill_discovery_includes_plugins_dir(tmp_path: Path, monkeypatch):
    """Plugins dir should be included in skill discovery roots."""
    from kaos.path import KaosPath
    from kimi_cli.skill import resolve_skills_roots

    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()

    # Create a valid plugin with SKILL.md
    plugin_dir = plugins_dir / "my-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "SKILL.md").write_text(
        "---\nname: my-plugin\ndescription: test\n---\n# Test",
        encoding="utf-8",
    )
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"name": "my-plugin", "version": "1.0.0"}),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "kimi_cli.skill.get_plugins_dir", lambda: plugins_dir
    )

    roots = await resolve_skills_roots(KaosPath(str(tmp_path)))
    root_strs = [str(r) for r in roots]
    assert str(plugins_dir) in root_strs
