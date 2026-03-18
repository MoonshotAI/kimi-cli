"""Plugin installation, removal, and listing."""

from __future__ import annotations

import shutil
from pathlib import Path

from kimi_cli.plugin import (
    PLUGIN_JSON,
    PluginError,
    PluginRuntime,
    PluginSpec,
    inject_config,
    parse_plugin_json,
    write_runtime,
)
from kimi_cli.share import get_share_dir


def get_plugins_dir() -> Path:
    """Return the plugins installation directory (~/.kimi/plugins/)."""
    return get_share_dir() / "plugins"


def install_plugin(
    *,
    source: Path,
    plugins_dir: Path,
    host_values: dict[str, str],
    host_name: str,
    host_version: str,
) -> PluginSpec:
    """Install a plugin from a source directory.

    1. Validate source plugin.json
    2. Copy to plugins_dir/<name>/
    3. Inject host values into plugin config
    4. Write runtime into plugin.json
    5. On failure, rollback (remove copied dir)
    """
    source_plugin_json = source / PLUGIN_JSON
    if not source_plugin_json.exists():
        raise PluginError(f"No plugin.json found in {source}")

    spec = parse_plugin_json(source_plugin_json)

    dest = plugins_dir / spec.name
    # For reinstall: remove old copy first
    if dest.exists():
        shutil.rmtree(dest)

    plugins_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, dest)

    try:
        inject_config(dest, spec, host_values)
        runtime = PluginRuntime(host=host_name, host_version=host_version)
        write_runtime(dest, runtime)
    except Exception:
        # Rollback on any failure
        shutil.rmtree(dest, ignore_errors=True)
        raise

    # Re-read to return the installed spec (with runtime)
    return parse_plugin_json(dest / PLUGIN_JSON)


def list_plugins(plugins_dir: Path) -> list[PluginSpec]:
    """List all installed plugins."""
    if not plugins_dir.is_dir():
        return []

    plugins: list[PluginSpec] = []
    for child in sorted(plugins_dir.iterdir()):
        plugin_json = child / PLUGIN_JSON
        if child.is_dir() and plugin_json.is_file():
            try:
                plugins.append(parse_plugin_json(plugin_json))
            except PluginError:
                continue
    return plugins


def remove_plugin(name: str, plugins_dir: Path) -> None:
    """Remove an installed plugin."""
    dest = plugins_dir / name
    if not dest.exists():
        raise PluginError(f"Plugin '{name}' not found in {plugins_dir}")
    shutil.rmtree(dest)
