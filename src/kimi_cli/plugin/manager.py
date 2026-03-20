"""Plugin installation, removal, and listing."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

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

if TYPE_CHECKING:
    from kimi_cli.auth.oauth import OAuthManager
    from kimi_cli.config import Config


def get_plugins_dir() -> Path:
    """Return the plugins installation directory (~/.kimi/plugins/)."""
    return get_share_dir() / "plugins"


def collect_host_values(config: Config, oauth: OAuthManager) -> dict[str, str]:
    """Collect host values (api_key, base_url) for plugin injection.

    Resolves credentials from the default provider, handling OAuth tokens
    and static API keys.  Callers that run outside the normal startup flow
    (e.g. ``install_cmd``) should apply environment-variable overrides
    (``augment_provider_with_env_vars``) to the provider **before** calling
    this function; the main app startup already does that.
    """
    values: dict[str, str] = {}
    if not config.default_model or config.default_model not in config.models:
        return values
    model = config.models[config.default_model]
    if model.provider not in config.providers:
        return values
    provider = config.providers[model.provider]
    api_key = oauth.resolve_api_key(provider.api_key, provider.oauth)
    if api_key:
        values["api_key"] = api_key
    values["base_url"] = provider.base_url
    return values


def _validate_name(name: str, plugins_dir: Path) -> Path:
    """Resolve and validate plugin name, returning the safe destination path."""
    dest = (plugins_dir / name).resolve()
    if not dest.is_relative_to(plugins_dir.resolve()):
        raise PluginError(f"Invalid plugin name: {name}")
    return dest


def install_plugin(
    *,
    source: Path,
    plugins_dir: Path,
    host_values: dict[str, str],
    host_name: str,
    host_version: str,
) -> PluginSpec:
    """Install a plugin from a source directory.

    Stages the new copy to a temp dir first, so a failed upgrade
    does not destroy the previous installation.
    """
    source_plugin_json = source / PLUGIN_JSON
    if not source_plugin_json.exists():
        raise PluginError(f"No plugin.json found in {source}")

    spec = parse_plugin_json(source_plugin_json)
    dest = _validate_name(spec.name, plugins_dir)

    # Stage to a temp dir inside plugins_dir so rename is atomic on same fs
    plugins_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{spec.name}-", dir=plugins_dir))
    try:
        # Copy source into staging
        staging_plugin = staging / spec.name
        shutil.copytree(source, staging_plugin)

        # Apply inject + runtime on the staged copy
        inject_config(staging_plugin, spec, host_values)
        runtime = PluginRuntime(host=host_name, host_version=host_version)
        write_runtime(staging_plugin, runtime)

        # Swap: remove old, move staged into place
        if dest.exists():
            shutil.rmtree(dest)
        staging_plugin.rename(dest)
    except Exception:
        # On any failure, clean up staging but leave existing install intact
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        # Clean up staging dir shell (may be empty after successful rename)
        shutil.rmtree(staging, ignore_errors=True)

    # Re-read to return the installed spec (with runtime)
    return parse_plugin_json(dest / PLUGIN_JSON)


def refresh_plugin_configs(plugins_dir: Path, host_values: dict[str, str]) -> None:
    """Re-inject host values into all installed plugin config files.

    Called at startup so that OAuth tokens and other credentials
    stay fresh even after the initial install.
    """
    if not plugins_dir.is_dir():
        return

    for child in sorted(plugins_dir.iterdir()):
        plugin_json = child / PLUGIN_JSON
        if not child.is_dir() or not plugin_json.is_file():
            continue
        try:
            spec = parse_plugin_json(plugin_json)
            if spec.inject and spec.config_file:
                inject_config(child, spec, host_values)
        except PluginError:
            continue


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
    dest = _validate_name(name, plugins_dir)
    if not dest.exists():
        raise PluginError(f"Plugin '{name}' not found in {plugins_dir}")
    shutil.rmtree(dest)
