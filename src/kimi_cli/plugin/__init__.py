"""Plugin specification parsing and config injection."""

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PluginError(Exception):
    """Raised when plugin.json is invalid or an operation fails."""


class PluginRuntime(BaseModel):
    """Runtime information written by the host after installation."""

    host: str
    host_version: str


class PluginToolSpec(BaseModel):
    """A tool declared by a plugin."""

    name: str
    description: str
    command: list[str]
    parameters: dict[str, object] = Field(default_factory=dict)


class PluginSpec(BaseModel):
    """Parsed representation of a plugin.json file."""

    model_config = ConfigDict(extra="ignore")

    name: str
    version: str
    description: str = ""
    config_file: str | None = None
    inject: dict[str, str] = Field(default_factory=dict)
    tools: list[PluginToolSpec] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    runtime: PluginRuntime | None = None


PLUGIN_JSON = "plugin.json"


def parse_plugin_json(path: Path) -> PluginSpec:
    """Parse a plugin.json file and return a validated PluginSpec."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PluginError(f"Failed to read {path}: {exc}") from exc

    if "name" not in data:
        raise PluginError(f"Missing required field 'name' in {path}")
    if "version" not in data:
        raise PluginError(f"Missing required field 'version' in {path}")
    if data.get("inject") and not data.get("config_file"):
        raise PluginError(f"'inject' requires 'config_file' in {path}")

    try:
        return PluginSpec.model_validate(data)
    except Exception as exc:
        raise PluginError(f"Invalid plugin.json schema in {path}: {exc}") from exc


def inject_config(plugin_dir: Path, spec: PluginSpec, values: dict[str, str]) -> None:
    """Inject host values into the plugin's config file.

    Args:
        plugin_dir: Root directory of the installed plugin.
        spec: Parsed plugin spec.
        values: Map of standard inject keys to actual values (e.g. {"api_key": "sk-xxx"}).
    """
    if not spec.inject or not spec.config_file:
        return

    config_path = (plugin_dir / spec.config_file).resolve()
    if not config_path.is_relative_to(plugin_dir.resolve()):
        raise PluginError(f"config_file escapes plugin directory: {spec.config_file}")
    if not config_path.exists():
        raise PluginError(f"Config file not found: {config_path}")

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PluginError(f"Failed to read config file {config_path}: {exc}") from exc

    for target_path, source_key in spec.inject.items():
        if source_key not in values:
            raise PluginError(f"Host does not provide required inject key '{source_key}'")
        _set_nested(config, target_path, values[source_key])

    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_runtime(plugin_dir: Path, runtime: PluginRuntime) -> None:
    """Write runtime info into plugin.json."""
    plugin_json_path = plugin_dir / PLUGIN_JSON
    try:
        data = json.loads(plugin_json_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PluginError(f"Failed to read {plugin_json_path}: {exc}") from exc
    data["runtime"] = runtime.model_dump()
    plugin_json_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _set_nested(obj: dict[str, Any], dotted_path: str, value: object) -> None:
    """Set a value in a nested dict using dot-separated path.

    Creates intermediate dicts if they don't exist.
    """
    keys = dotted_path.split(".")
    for key in keys[:-1]:
        if key not in obj or not isinstance(obj[key], dict):
            obj[key] = {}
        obj = obj[key]
    obj[keys[-1]] = value
