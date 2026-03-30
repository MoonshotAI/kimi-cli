# Plugin System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add plugin support to kimi-cli so that special Skills (with their own config files) can be installed, configured, and managed via `kimi plugin` commands.

**Architecture:** A new `plugin` module handles plugin.json parsing, config injection, and install/remove operations. A new `cli/plugin.py` registers `kimi plugin` subcommands via Typer. The existing skill discovery system is extended to also scan the plugins directory (`~/.config/agents/plugins/`).

**Tech Stack:** Python 3.12+, Typer (CLI), Pydantic (models), JSON (plugin.json + config files), shutil (file operations)

**Spec:** `docs/plugin-spec.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/kimi_cli/plugin/__init__.py` | Plugin model, plugin.json parsing, config injection logic |
| Create | `src/kimi_cli/plugin/manager.py` | Install, remove, list, info operations |
| Create | `src/kimi_cli/cli/plugin.py` | Typer CLI commands for `kimi plugin` |
| Modify | `src/kimi_cli/cli/__init__.py` | Register plugin CLI |
| Modify | `src/kimi_cli/skill/__init__.py` | Add plugins dir to skill discovery roots |
| Create | `tests/core/test_plugin.py` | Unit tests for plugin module |
| Create | `tests/core/test_plugin_manager.py` | Unit tests for manager (install/remove/list) and skill discovery |

---

## Chunk 1: Plugin Model & Config Injection

### Task 1: Plugin model and plugin.json parsing

**Files:**
- Create: `src/kimi_cli/plugin/__init__.py`
- Create: `tests/core/test_plugin.py`

- [ ] **Step 1: Write failing tests for plugin.json parsing**

```python
# tests/core/test_plugin.py
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'kimi_cli.plugin'`

- [ ] **Step 3: Implement plugin model and parsing**

```python
# src/kimi_cli/plugin/__init__.py
"""Plugin specification parsing and config injection."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field


class PluginError(Exception):
    """Raised when plugin.json is invalid or an operation fails."""


class PluginRuntime(BaseModel):
    """Runtime information written by the host after installation."""

    host: str
    host_version: str


class PluginSpec(BaseModel):
    """Parsed representation of a plugin.json file."""

    name: str
    version: str
    description: str = ""
    config_file: str | None = None
    inject: dict[str, str] = Field(default_factory=dict)
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
        raise PluginError(
            f"'inject' requires 'config_file' in {path}"
        )

    return PluginSpec.model_validate(data)


def inject_config(plugin_dir: Path, spec: PluginSpec, values: dict[str, str]) -> None:
    """Inject host values into the plugin's config file.

    Args:
        plugin_dir: Root directory of the installed plugin.
        spec: Parsed plugin spec.
        values: Map of standard inject keys to actual values (e.g. {"api_key": "sk-xxx"}).
    """
    if not spec.inject or not spec.config_file:
        return

    config_path = plugin_dir / spec.config_file
    if not config_path.exists():
        raise PluginError(f"Config file not found: {config_path}")

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PluginError(f"Failed to read config file {config_path}: {exc}") from exc

    for target_path, source_key in spec.inject.items():
        if source_key not in values:
            raise PluginError(
                f"Host does not provide required inject key '{source_key}'"
            )
        _set_nested(config, target_path, values[source_key])

    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_runtime(plugin_dir: Path, runtime: PluginRuntime) -> None:
    """Write runtime info into plugin.json."""
    plugin_json_path = plugin_dir / PLUGIN_JSON
    data = json.loads(plugin_json_path.read_text(encoding="utf-8"))
    data["runtime"] = runtime.model_dump()
    plugin_json_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _set_nested(obj: dict, dotted_path: str, value: object) -> None:
    """Set a value in a nested dict using dot-separated path.

    Creates intermediate dicts if they don't exist.
    """
    keys = dotted_path.split(".")
    for key in keys[:-1]:
        if key not in obj or not isinstance(obj[key], dict):
            obj[key] = {}
        obj = obj[key]
    obj[keys[-1]] = value
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin.py -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/plugin/__init__.py tests/core/test_plugin.py
git commit -m "feat(plugin): add plugin.json model and parsing"
```

### Task 2: Config injection logic tests

**Files:**
- Modify: `tests/core/test_plugin.py`

- [ ] **Step 1: Write failing tests for config injection**

Append to `tests/core/test_plugin.py`:

```python
from kimi_cli.plugin import inject_config, write_runtime, PluginRuntime


def test_parse_plugin_json_missing_version(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text('{"name": "x"}', encoding="utf-8")
    with pytest.raises(PluginError, match="version"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_malformed(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text('{not json}', encoding="utf-8")
    with pytest.raises(PluginError, match="Failed to read"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_inject_config_writes_value(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "p",
        "version": "1.0.0",
        "config_file": "config/config.json",
        "inject": {"kimicode.api_key": "api_key"},
    })
    # Create the config file with placeholder
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
    plugin_dir = _write_plugin(tmp_path, {
        "name": "p",
        "version": "1.0.0",
        "config_file": "c.json",
        "inject": {"a.b.c": "api_key"},
    })
    (plugin_dir / "c.json").write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    inject_config(plugin_dir, spec, {"api_key": "val"})

    result = json.loads((plugin_dir / "c.json").read_text())
    assert result["a"]["b"]["c"] == "val"


def test_inject_config_missing_key_raises(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "p",
        "version": "1.0.0",
        "config_file": "c.json",
        "inject": {"x": "api_key"},
    })
    (plugin_dir / "c.json").write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="api_key"):
        inject_config(plugin_dir, spec, {})


def test_inject_config_missing_file_raises(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "p",
        "version": "1.0.0",
        "config_file": "missing.json",
        "inject": {"x": "api_key"},
    })

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="not found"):
        inject_config(plugin_dir, spec, {"api_key": "v"})


def test_write_runtime(tmp_path: Path):
    plugin_dir = _write_plugin(tmp_path, {
        "name": "p",
        "version": "1.0.0",
    })

    runtime = PluginRuntime(host="kimi-code", host_version="1.22.0")
    write_runtime(plugin_dir, runtime)

    data = json.loads((plugin_dir / "plugin.json").read_text())
    assert data["runtime"]["host"] == "kimi-code"
    assert data["runtime"]["host_version"] == "1.22.0"
    assert data["name"] == "p"  # original fields preserved
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin.py -v`
Expected: All 12 tests PASS (these tests use already-implemented code)

- [ ] **Step 3: Commit**

```bash
git add tests/core/test_plugin.py
git commit -m "test(plugin): add config injection and runtime tests"
```

---

## Chunk 2: Plugin Manager (Install/Remove/List)

### Task 3: Plugin manager - install, remove, list

**Files:**
- Create: `src/kimi_cli/plugin/manager.py`
- Create: `tests/core/test_plugin_manager.py`

- [ ] **Step 1: Write failing tests for plugin manager**

```python
# tests/core/test_plugin_manager.py
from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.plugin import PluginError, PluginRuntime
from kimi_cli.plugin.manager import (
    get_plugins_dir,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin_manager.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'kimi_cli.plugin.manager'`

- [ ] **Step 3: Implement plugin manager**

```python
# src/kimi_cli/plugin/manager.py
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

DEFAULT_PLUGINS_DIR = Path.home() / ".config" / "agents" / "plugins"


def get_plugins_dir() -> Path:
    """Return the plugins installation directory."""
    return DEFAULT_PLUGINS_DIR


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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin_manager.py -v`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/plugin/manager.py tests/core/test_plugin_manager.py
git commit -m "feat(plugin): add plugin manager (install/remove/list)"
```

---

## Chunk 3: CLI Commands & Skill Discovery Integration

### Task 4: CLI commands for `kimi plugin`

**Files:**
- Create: `src/kimi_cli/cli/plugin.py`
- Modify: `src/kimi_cli/cli/__init__.py`

- [ ] **Step 1: Create plugin CLI module**

```python
# src/kimi_cli/cli/plugin.py
"""CLI commands for plugin management."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from kimi_cli.plugin import PluginError

cli = typer.Typer(help="Manage plugins.")


@cli.command("install")
def install_cmd(
    path: Annotated[Path, typer.Argument(help="Path to the plugin source directory")],
) -> None:
    """Install a plugin and inject host configuration."""
    from kimi_cli.config import load_config
    from kimi_cli.constant import VERSION
    from kimi_cli.plugin.manager import get_plugins_dir, install_plugin

    source = path.expanduser().resolve()
    if not source.is_dir():
        typer.echo(f"Error: {source} is not a directory", err=True)
        raise typer.Exit(1)

    config = load_config()

    # Collect host values from the current default provider
    host_values: dict[str, str] = {}
    if config.default_model and config.default_model in config.models:
        model = config.models[config.default_model]
        if model.provider in config.providers:
            provider = config.providers[model.provider]
            host_values["api_key"] = provider.api_key.get_secret_value()
            host_values["base_url"] = provider.base_url

    try:
        spec = install_plugin(
            source=source,
            plugins_dir=get_plugins_dir(),
            host_values=host_values,
            host_name="kimi-code",
            host_version=VERSION,
        )
    except PluginError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1) from exc

    typer.echo(f"Installed plugin '{spec.name}' v{spec.version}")
    if spec.runtime:
        typer.echo(f"  runtime: host={spec.runtime.host}, version={spec.runtime.host_version}")


@cli.command("list")
def list_cmd() -> None:
    """List installed plugins."""
    from kimi_cli.plugin.manager import get_plugins_dir, list_plugins

    plugins = list_plugins(get_plugins_dir())
    if not plugins:
        typer.echo("No plugins installed.")
        return

    for p in plugins:
        status = "installed" if p.runtime else "not configured"
        typer.echo(f"  {p.name} v{p.version} ({status})")


@cli.command("remove")
def remove_cmd(
    name: Annotated[str, typer.Argument(help="Plugin name to remove")],
) -> None:
    """Remove an installed plugin."""
    from kimi_cli.plugin.manager import get_plugins_dir, remove_plugin

    try:
        remove_plugin(name, get_plugins_dir())
    except PluginError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1) from exc

    typer.echo(f"Removed plugin '{name}'")


@cli.command("info")
def info_cmd(
    name: Annotated[str, typer.Argument(help="Plugin name")],
) -> None:
    """Show plugin details."""
    from kimi_cli.plugin import parse_plugin_json
    from kimi_cli.plugin.manager import get_plugins_dir

    plugin_json = get_plugins_dir() / name / "plugin.json"
    if not plugin_json.exists():
        typer.echo(f"Error: Plugin '{name}' not found", err=True)
        raise typer.Exit(1)

    try:
        spec = parse_plugin_json(plugin_json)
    except PluginError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1) from exc

    typer.echo(f"Name:        {spec.name}")
    typer.echo(f"Version:     {spec.version}")
    typer.echo(f"Description: {spec.description or '(none)'}")
    typer.echo(f"Config file: {spec.config_file or '(none)'}")
    if spec.inject:
        typer.echo(f"Inject:      {', '.join(f'{k} <- {v}' for k, v in spec.inject.items())}")
    if spec.runtime:
        typer.echo(f"Runtime:     host={spec.runtime.host}, version={spec.runtime.host_version}")
    else:
        typer.echo("Runtime:     (not installed via host)")
```

- [ ] **Step 2: Register plugin CLI in main CLI**

Add to `src/kimi_cli/cli/__init__.py`:

After line 17 (`from .web import cli as web_cli`), add:
```python
from .plugin import cli as plugin_cli
```

After line 809 (`cli.add_typer(web_cli, name="web")`), add:
```python
cli.add_typer(plugin_cli, name="plugin")
```

- [ ] **Step 3: Verify CLI works**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m kimi_cli.cli plugin --help`
Expected: Shows help for `install`, `list`, `remove`, `info` subcommands

- [ ] **Step 4: Commit**

```bash
git add src/kimi_cli/cli/plugin.py src/kimi_cli/cli/__init__.py
git commit -m "feat(plugin): add kimi plugin CLI commands"
```

### Task 5: Integrate plugins into skill discovery

**Files:**
- Modify: `src/kimi_cli/skill/__init__.py`

- [ ] **Step 1: Write failing test for plugin discovery**

Append to `tests/core/test_plugin_manager.py`:

```python
import pytest

from kimi_cli.plugin.manager import get_plugins_dir


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
    # The plugins dir should be one of the roots
    root_strs = [str(r) for r in roots]
    assert str(plugins_dir) in root_strs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin_manager.py::test_skill_discovery_includes_plugins_dir -v`
Expected: FAIL

- [ ] **Step 3: Add plugins dir to skill discovery**

Modify `src/kimi_cli/skill/__init__.py`:

After the existing imports (line 13), add:
```python
from kimi_cli.plugin.manager import get_plugins_dir
```

In `resolve_skills_roots()`, after the project-level skills block (after line 105), add:
```python
    # Plugin directory
    plugins_path = get_plugins_dir()
    if plugins_path.exists():
        roots.append(KaosPath.unsafe_from_local_path(plugins_path))
```

- [ ] **Step 4: Run all tests**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin.py tests/core/test_plugin_manager.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/skill/__init__.py tests/core/test_plugin_manager.py
git commit -m "feat(plugin): integrate plugins dir into skill discovery"
```

---

## Chunk 4: Final Verification

### Task 6: End-to-end manual verification

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/core/test_plugin.py tests/core/test_plugin_manager.py -v`
Expected: All tests PASS

- [ ] **Step 2: Run linter**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m ruff check src/kimi_cli/plugin/ src/kimi_cli/cli/plugin.py`
Expected: No errors

- [ ] **Step 3: Run type checker**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pyright src/kimi_cli/plugin/ src/kimi_cli/cli/plugin.py`
Expected: No errors (or only pre-existing issues)

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(plugin): address lint/type issues"
```
