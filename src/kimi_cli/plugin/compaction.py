"""Load an explicitly selected compaction implementation from an installed plugin."""

from __future__ import annotations

import importlib
import sys
from contextlib import suppress
from pathlib import Path
from types import ModuleType
from typing import cast

from kimi_cli.plugin import PLUGIN_JSON, PluginError, parse_plugin_json
from kimi_cli.soul.compaction import Compaction


def _purge_module_path(module_path: str) -> None:
    prefixes = (module_path, f"{module_path}.")
    for key in list(sys.modules):
        if key == prefixes[0] or key.startswith(prefixes[1]):
            del sys.modules[key]


def _ensure_module_is_from_plugin(
    module: ModuleType, *, module_path: str, plugin_dir: Path
) -> None:
    module_file = getattr(module, "__file__", None)
    if module_file is None:
        raise PluginError(f"Compaction module {module_path!r} has no file location")

    resolved_module = Path(module_file).resolve()
    resolved_plugin = plugin_dir.resolve()
    if not resolved_module.is_relative_to(resolved_plugin):
        raise PluginError(
            f"Compaction module {module_path!r} resolved outside plugin directory {resolved_plugin}"
        )


def _instantiate_compactor(plugin_dir: Path, entrypoint: str) -> Compaction:
    module_path, _, class_name = entrypoint.rpartition(".")
    if not module_path:
        raise PluginError(f"Invalid compaction entrypoint: {entrypoint!r}")

    plugin_root = str(plugin_dir.resolve())
    if plugin_root not in sys.path:
        sys.path.insert(0, plugin_root)
        inserted = True
    else:
        inserted = False

    try:
        _purge_module_path(module_path)
        module = importlib.import_module(module_path)
    finally:
        if inserted:
            with suppress(ValueError):
                sys.path.remove(plugin_root)

    _ensure_module_is_from_plugin(module, module_path=module_path, plugin_dir=plugin_dir)

    try:
        cls = getattr(module, class_name)
    except AttributeError as exc:
        raise PluginError(
            f"Compaction class {class_name!r} not found in module {module_path!r}"
        ) from exc

    instance = cls()
    compact = getattr(instance, "compact", None)
    if compact is None or not callable(compact):
        raise PluginError(f"Compaction object from {entrypoint!r} has no callable compact()")
    return cast(Compaction, instance)


def resolve_plugin_compactor(plugins_dir: Path, plugin_name: str | None) -> Compaction | None:
    """Load one explicitly selected plugin compactor.

    Returns ``None`` when no plugin compactor is configured.
    Raises ``PluginError`` when the selected plugin is missing, invalid, or does not declare
    a compaction entrypoint.
    """
    if plugin_name is None:
        return None
    if plugin_name == "":
        raise PluginError("Plugin name cannot be empty")
    if not plugins_dir.is_dir():
        raise PluginError(f"Plugins directory not found: {plugins_dir}")

    plugin_dir = (plugins_dir / plugin_name).resolve()
    if not plugin_dir.is_relative_to(plugins_dir.resolve()):
        raise PluginError(f"Invalid plugin name: {plugin_name}")

    plugin_json = plugin_dir / PLUGIN_JSON
    if not plugin_dir.is_dir() or not plugin_json.is_file():
        raise PluginError(f"Plugin {plugin_name!r} not found in {plugins_dir}")

    spec = parse_plugin_json(plugin_json)
    if spec.compaction is None:
        raise PluginError(f"Plugin {plugin_name!r} does not declare compaction.entrypoint")

    return _instantiate_compactor(plugin_dir, spec.compaction.entrypoint)
