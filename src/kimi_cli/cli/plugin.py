"""CLI commands for plugin management."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from kimi_cli.plugin import PluginError

cli = typer.Typer(help="Manage plugins.")


def _parse_git_url(target: str) -> tuple[str, str | None, str | None]:
    """Parse a git URL into (clone_url, subpath, branch).

    Splits .git URLs at the .git boundary. For GitHub/GitLab short URLs,
    treats the first two path segments as owner/repo and the rest as subpath.
    Strips ``tree/{branch}/`` or ``-/tree/{branch}/`` prefixes from
    browser-copied URLs and returns the branch name.
    """
    # Path 1: URL contains .git followed by / or end-of-string
    idx = target.find(".git/")
    if idx == -1 and target.endswith(".git"):
        return target, None, None
    if idx != -1:
        clone_url = target[: idx + 4]  # up to and including ".git"
        rest = target[idx + 5 :]  # after ".git/"
        subpath = rest.strip("/") or None
        return clone_url, subpath, None

    # Path 2: GitHub/GitLab short URL (no .git)
    from urllib.parse import urlparse

    parsed = urlparse(target)
    segments = [s for s in parsed.path.split("/") if s]
    if len(segments) < 2:
        return target, None, None

    owner_repo = "/".join(segments[:2])
    clone_url = f"{parsed.scheme}://{parsed.netloc}/{owner_repo}"
    rest_segments = segments[2:]

    # GitLab uses /-/tree/{branch}/, strip leading "-"
    if rest_segments and rest_segments[0] == "-":
        rest_segments = rest_segments[1:]

    # Strip tree/{branch}/ prefix and extract branch
    branch: str | None = None
    if len(rest_segments) >= 2 and rest_segments[0] == "tree":
        branch = rest_segments[1]
        rest_segments = rest_segments[2:]

    subpath = "/".join(rest_segments) or None
    return clone_url, subpath, branch


def _extract_zip_to_plugin(zip_path: Path, tmp: Path) -> tuple[Path, Path]:
    """Extract zip_path into tmp and locate the plugin directory.

    Returns ``(plugin_dir, tmp)`` for cleanup by the caller. Rejects zip
    members whose paths escape ``tmp``. Searches the extraction root and
    one level deep for ``plugin.json``.
    """
    import shutil
    import zipfile

    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.namelist():
            member_path = (tmp / member).resolve()
            if not member_path.is_relative_to(tmp.resolve()):
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(f"Error: zip contains unsafe path: {member}", err=True)
                raise typer.Exit(1)
        zf.extractall(tmp)

    for candidate in [tmp] + sorted(tmp.iterdir()):
        if candidate.is_dir() and (candidate / "plugin.json").exists():
            return candidate, tmp
    dirs = [d for d in tmp.iterdir() if d.is_dir() and not d.name.startswith("_")]
    if len(dirs) == 1 and (dirs[0] / "plugin.json").exists():
        return dirs[0], tmp

    shutil.rmtree(tmp, ignore_errors=True)
    typer.echo("Error: No plugin.json found in zip", err=True)
    raise typer.Exit(1)


def _resolve_source(target: str) -> tuple[Path, Path | None]:
    """Resolve plugin source to (local_dir, tmp_to_cleanup).

    Returns the source directory and an optional temp directory that
    the caller must clean up after use.
    """
    import shutil
    import tempfile
    from urllib.parse import urlparse

    # HTTP(S) URL pointing to a .zip — download then extract.
    # Checked before the git-URL branch so GitHub/GitLab archive links
    # like .../archive/refs/heads/main.zip take this path.
    parsed = urlparse(target)
    if parsed.scheme in ("http", "https") and parsed.path.lower().endswith(".zip"):
        import httpx

        tmp = Path(tempfile.mkdtemp(prefix="kimi-plugin-"))
        zip_path = tmp / "_download.zip"
        typer.echo(f"Downloading {target}...")
        try:
            with httpx.stream("GET", target, follow_redirects=True, timeout=60.0) as resp:
                resp.raise_for_status()
                with zip_path.open("wb") as f:
                    for chunk in resp.iter_bytes():
                        f.write(chunk)
        except httpx.HTTPError as exc:
            shutil.rmtree(tmp, ignore_errors=True)
            typer.echo(f"Error: download failed: {exc}", err=True)
            raise typer.Exit(1) from exc

        return _extract_zip_to_plugin(zip_path, tmp)

    # Git URL
    if target.startswith(("https://", "git@", "http://")) and (
        ".git/" in target
        or target.endswith(".git")
        or "github.com/" in target
        or "gitlab.com/" in target
    ):
        import subprocess

        clone_url, subpath, branch = _parse_git_url(target)

        tmp = Path(tempfile.mkdtemp(prefix="kimi-plugin-"))
        typer.echo(f"Cloning {clone_url}...")
        clone_cmd = ["git", "clone", "--depth", "1"]
        if branch:
            clone_cmd += ["--branch", branch]
        clone_cmd += [clone_url, str(tmp / "repo")]
        result = subprocess.run(
            clone_cmd,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            shutil.rmtree(tmp, ignore_errors=True)
            typer.echo(
                f"Error: git clone failed: {result.stderr.strip()}",
                err=True,
            )
            raise typer.Exit(1)

        repo_root = tmp / "repo"

        if subpath:
            source = (repo_root / subpath).resolve()
            if not source.is_relative_to(repo_root.resolve()):
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(
                    f"Error: subpath escapes repository: {subpath}",
                    err=True,
                )
                raise typer.Exit(1)
            if not source.is_dir():
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(
                    f"Error: subpath '{subpath}' not found in repository",
                    err=True,
                )
                raise typer.Exit(1)
            if not (source / "plugin.json").exists():
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(
                    f"Error: no plugin.json in '{subpath}'",
                    err=True,
                )
                raise typer.Exit(1)
            return source, tmp

        # No subpath — check root first
        if (repo_root / "plugin.json").exists():
            return repo_root, tmp

        # Scan one level for available plugins
        available = sorted(
            d.name for d in repo_root.iterdir() if d.is_dir() and (d / "plugin.json").exists()
        )
        if available:
            names = "\n".join(f"  - {n}" for n in available)
            typer.echo(
                f"Error: No plugin.json at repository root. "
                f"Available plugins:\n{names}\n"
                f"Use: kimi plugin install <url>/<plugin-name>",
                err=True,
            )
        else:
            typer.echo(
                "Error: No plugin.json found in repository",
                err=True,
            )
        shutil.rmtree(tmp, ignore_errors=True)
        raise typer.Exit(1)

    p = Path(target).expanduser().resolve()

    # Zip file
    if p.is_file() and p.suffix == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="kimi-plugin-"))
        typer.echo(f"Extracting {p.name}...")
        return _extract_zip_to_plugin(p, tmp)

    # Local directory
    if p.is_dir():
        return p, None

    typer.echo(
        f"Error: {target} is not a directory, zip file, zip URL, or git URL",
        err=True,
    )
    raise typer.Exit(1)


@cli.command("install")
def install_cmd(
    target: Annotated[
        str,
        typer.Argument(help="Plugin source: directory, .zip file, .zip URL, or git URL"),
    ],
) -> None:
    """Install a plugin and inject host configuration."""
    import shutil

    from kimi_cli.config import load_config
    from kimi_cli.constant import VERSION
    from kimi_cli.plugin.manager import get_plugins_dir, install_plugin

    source, tmp_dir = _resolve_source(target)

    try:
        config = load_config()

        from kimi_cli.auth.oauth import OAuthManager
        from kimi_cli.llm import augment_provider_with_env_vars
        from kimi_cli.plugin.manager import collect_host_values

        # Apply env var overrides (install runs outside normal startup)
        if config.default_model and config.default_model in config.models:
            model = config.models[config.default_model]
            if model.provider in config.providers:
                augment_provider_with_env_vars(config.providers[model.provider], model)

        oauth = OAuthManager(config)
        host_values = collect_host_values(config, oauth)

        if not host_values.get("api_key"):
            typer.echo(
                "Warning: No LLM provider configured. "
                "Plugins requiring API key injection will fail. "
                "Run 'kimi login' or configure a provider first.",
                err=True,
            )

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
    finally:
        # Clean up temp directory from zip/git extraction
        if tmp_dir is not None:
            shutil.rmtree(tmp_dir, ignore_errors=True)

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
