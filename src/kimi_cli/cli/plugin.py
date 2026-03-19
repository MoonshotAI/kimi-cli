"""CLI commands for plugin management."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from kimi_cli.plugin import PluginError

cli = typer.Typer(help="Manage plugins.")


def _resolve_source(target: str) -> Path:
    """Resolve a plugin source from a path (directory or zip) or git URL to a local directory."""
    import shutil
    import tempfile

    # Git URL
    if target.startswith(("https://", "git@", "http://")) and (
        target.endswith(".git") or "github.com/" in target or "gitlab.com/" in target
    ):
        import subprocess

        tmp = Path(tempfile.mkdtemp(prefix="kimi-plugin-"))
        typer.echo(f"Cloning {target}...")
        result = subprocess.run(
            ["git", "clone", "--depth", "1", target, str(tmp / "repo")],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            shutil.rmtree(tmp, ignore_errors=True)
            typer.echo(f"Error: git clone failed: {result.stderr.strip()}", err=True)
            raise typer.Exit(1)
        return tmp / "repo"

    p = Path(target).expanduser().resolve()

    # Zip file
    if p.is_file() and p.suffix == ".zip":
        import zipfile

        tmp = Path(tempfile.mkdtemp(prefix="kimi-plugin-"))
        typer.echo(f"Extracting {p.name}...")
        with zipfile.ZipFile(p, "r") as zf:
            zf.extractall(tmp)
        # Find the directory containing plugin.json (may be nested one level)
        for candidate in [tmp] + sorted(tmp.iterdir()):
            if candidate.is_dir() and (candidate / "plugin.json").exists():
                return candidate
        # Check for __MACOSX and similar artifacts
        dirs = [d for d in tmp.iterdir() if d.is_dir() and not d.name.startswith("_")]
        if len(dirs) == 1 and (dirs[0] / "plugin.json").exists():
            return dirs[0]
        shutil.rmtree(tmp, ignore_errors=True)
        typer.echo("Error: No plugin.json found in zip", err=True)
        raise typer.Exit(1)

    # Local directory
    if p.is_dir():
        return p

    typer.echo(f"Error: {target} is not a directory, zip file, or git URL", err=True)
    raise typer.Exit(1)


@cli.command("install")
def install_cmd(
    target: Annotated[str, typer.Argument(help="Plugin source: directory path, .zip file, or git URL")],
) -> None:
    """Install a plugin and inject host configuration."""
    from kimi_cli.config import load_config
    from kimi_cli.constant import VERSION
    from kimi_cli.plugin.manager import get_plugins_dir, install_plugin

    source = _resolve_source(target)

    config = load_config()

    # Collect host values from the current default provider
    host_values: dict[str, str] = {}
    if config.default_model and config.default_model in config.models:
        model = config.models[config.default_model]
        if model.provider in config.providers:
            provider = config.providers[model.provider]
            host_values["api_key"] = provider.api_key.get_secret_value()
            host_values["base_url"] = provider.base_url

    if not host_values:
        typer.echo(
            "Warning: No LLM provider configured. "
            "Plugins requiring API key injection will fail. "
            "Run 'kimi login' or configure a provider first.",
            err=True,
        )

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
