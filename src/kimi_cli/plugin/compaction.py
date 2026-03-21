"""Load optional compaction implementations from installed plugins."""

from __future__ import annotations

import importlib
import sys
from contextlib import suppress
from pathlib import Path
from typing import cast

from loguru import logger

from kimi_cli.plugin import PLUGIN_JSON, PluginError, parse_plugin_json
from kimi_cli.soul.compaction import Compaction


def _purge_top_level_module(dotted: str) -> None:
    """Drop a previously imported top-level package so another plugin can reuse the name."""
    top, _, _ = dotted.partition(".")
    doomed = [k for k in list(sys.modules) if k == top or k.startswith(f"{top}.")]
    for key in doomed:
        del sys.modules[key]


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
        _purge_top_level_module(module_path)
        module = importlib.import_module(module_path)
    finally:
        if inserted:
            with suppress(ValueError):
                sys.path.remove(plugin_root)

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


def resolve_plugin_compactor(plugins_dir: Path) -> Compaction | None:
    """Return the first successfully loaded compactor from installed plugins, if any.

    Plugins are scanned in sorted directory order. If more than one declares ``compaction``,
    only the first loaded implementation is used; others are skipped with a warning.
    """
    if not plugins_dir.is_dir():
        return None

    chosen: Compaction | None = None
    for child in sorted(plugins_dir.iterdir()):
        plugin_json = child / PLUGIN_JSON
        if not child.is_dir() or not plugin_json.is_file():
            continue
        try:
            spec = parse_plugin_json(plugin_json)
        except PluginError:
            continue
        if spec.compaction is None:
            continue
        if chosen is not None:
            logger.warning(
                "Ignoring compaction from plugin {plugin}: already using another plugin compactor",
                plugin=spec.name,
            )
            continue
        try:
            chosen = _instantiate_compactor(child, spec.compaction.entrypoint)
        except Exception:
            logger.warning(
                "Failed to load compaction from plugin {plugin}: {entrypoint}",
                plugin=spec.name,
                entrypoint=spec.compaction.entrypoint,
                exc_info=True,
            )
            continue
        logger.info(
            "Loaded plugin compaction: {entrypoint} (plugin {plugin})",
            entrypoint=spec.compaction.entrypoint,
            plugin=spec.name,
        )

    return chosen
