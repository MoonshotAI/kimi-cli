"""Load an explicitly selected compaction implementation from an installed plugin."""

from __future__ import annotations

import importlib.util
import sys
from hashlib import sha1
from pathlib import Path
from threading import Lock
from types import ModuleType
from typing import cast

from kimi_cli.plugin import PLUGIN_JSON, PluginError, parse_plugin_json
from kimi_cli.soul.compaction import Compaction

_IMPORT_LOCK = Lock()
_PLUGIN_PATH_REFS: dict[str, tuple[int, bool]] = {}


def _plugin_package_name(plugin_dir: Path) -> str:
    digest = sha1(str(plugin_dir.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"_kimi_plugin_compaction_{digest}"


def _resolve_module_file(plugin_dir: Path, module_path: str) -> tuple[Path, bool]:
    module_parts = module_path.split(".")
    file_base = plugin_dir.joinpath(*module_parts)
    module_file = file_base.with_suffix(".py")
    if module_file.is_file():
        return module_file, False

    package_init = file_base / "__init__.py"
    if package_init.is_file():
        return package_init, True

    raise PluginError(
        f"Compaction module {module_path!r} not found in plugin directory {plugin_dir}"
    )


def _ensure_package_module(package_name: str, package_dir: Path) -> None:
    module = sys.modules.get(package_name)
    if module is None:
        module = ModuleType(package_name)
        module.__file__ = str(package_dir / "__init__.py")
        module.__package__ = package_name
        module.__path__ = [str(package_dir)]
        sys.modules[package_name] = module


def _is_module_from_any_plugin_dir(module: ModuleType) -> bool:
    module_file = getattr(module, "__file__", None)
    if module_file is None:
        return False
    return any(parent.name == "plugins" for parent in Path(module_file).resolve().parents)


def _local_top_level_module_names(plugin_dir: Path) -> set[str]:
    names: set[str] = set()
    for child in plugin_dir.iterdir():
        if child.is_file() and child.suffix == ".py":
            names.add(child.stem)
        elif child.is_dir() and (child / "__init__.py").is_file():
            names.add(child.name)
    return names


def _purge_conflicting_top_level_modules(plugin_dir: Path) -> None:
    for name in _local_top_level_module_names(plugin_dir):
        module = sys.modules.get(name)
        if module is not None and _is_module_from_any_plugin_dir(module):
            sys.modules.pop(name, None)


def _load_plugin_module(plugin_dir: Path, module_path: str) -> ModuleType:
    module_file, is_package = _resolve_module_file(plugin_dir, module_path)
    plugin_root = str(plugin_dir.resolve())
    package_name = _plugin_package_name(plugin_dir)
    module_parts = module_path.split(".")
    module_name = ".".join((package_name, *module_parts))

    with _IMPORT_LOCK:
        _ensure_package_module(package_name, plugin_dir)
        _purge_conflicting_top_level_modules(plugin_dir)
        parent_dir = plugin_dir
        parent_package = package_name
        for part in module_parts[:-1]:
            parent_dir = parent_dir / part
            parent_package = f"{parent_package}.{part}"
            _ensure_package_module(parent_package, parent_dir)

        sys.modules.pop(module_name, None)
        spec = importlib.util.spec_from_file_location(
            module_name,
            module_file,
            submodule_search_locations=[str(module_file.parent)] if is_package else None,
        )
        if spec is None or spec.loader is None:
            raise PluginError(f"Failed to load compaction module {module_path!r}")

        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        _acquire_plugin_path_locked(plugin_root)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            sys.modules.pop(module_name, None)
            raise PluginError(f"Failed to import compaction module {module_path!r}: {exc}") from exc
        finally:
            _release_plugin_path_locked(plugin_root)

    return module


def _acquire_plugin_path_locked(plugin_root: str) -> None:
    count, inserted = _PLUGIN_PATH_REFS.get(plugin_root, (0, plugin_root not in sys.path))
    if count == 0 and inserted:
        sys.path.append(plugin_root)
    _PLUGIN_PATH_REFS[plugin_root] = (count + 1, inserted)


def _acquire_plugin_path(plugin_dir: Path) -> str:
    plugin_root = str(plugin_dir.resolve())
    with _IMPORT_LOCK:
        _acquire_plugin_path_locked(plugin_root)
    return plugin_root


def _release_plugin_path_locked(plugin_root: str) -> None:
    count, inserted = _PLUGIN_PATH_REFS[plugin_root]
    if count <= 1:
        _PLUGIN_PATH_REFS.pop(plugin_root, None)
        if inserted and plugin_root in sys.path:
            sys.path.remove(plugin_root)
        return
    _PLUGIN_PATH_REFS[plugin_root] = (count - 1, inserted)


def _release_plugin_path(plugin_root: str) -> None:
    with _IMPORT_LOCK:
        _release_plugin_path_locked(plugin_root)


def _wrap_compactor_for_lazy_imports(instance: Compaction, plugin_dir: Path) -> Compaction:
    original_compact = getattr(instance, "compact", None)
    if original_compact is None or not callable(original_compact):
        raise PluginError("Compaction object has no callable compact()")

    instance.__kimi_plugin_dir__ = str(plugin_dir.resolve())

    async def compact(*args, **kwargs):
        plugin_root = _acquire_plugin_path(plugin_dir)
        try:
            with _IMPORT_LOCK:
                _purge_conflicting_top_level_modules(plugin_dir)
            return await original_compact(*args, **kwargs)
        finally:
            _release_plugin_path(plugin_root)

    instance.compact = compact
    return instance


def instantiate_plugin_compactor(plugin_dir: Path, entrypoint: str) -> Compaction:
    module_path, _, class_name = entrypoint.rpartition(".")
    if not module_path:
        raise PluginError(f"Invalid compaction entrypoint: {entrypoint!r}")

    module = _load_plugin_module(plugin_dir, module_path)

    try:
        cls = getattr(module, class_name)
    except AttributeError as exc:
        raise PluginError(
            f"Compaction class {class_name!r} not found in module {module_path!r}"
        ) from exc

    try:
        instance = cls()
    except Exception as exc:
        raise PluginError(
            "Failed to initialize compaction class "
            f"{class_name!r} from module {module_path!r}: {exc}"
        ) from exc
    if not getattr(instance, "compact", None) or not callable(instance.compact):
        raise PluginError(f"Compaction object from {entrypoint!r} has no callable compact()")
    return cast(Compaction, _wrap_compactor_for_lazy_imports(instance, plugin_dir))


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

    return instantiate_plugin_compactor(plugin_dir, spec.compaction.entrypoint)
