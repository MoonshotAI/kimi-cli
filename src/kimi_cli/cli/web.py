"""Web UI command for Kimi Code CLI."""

import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Annotated

import typer

cli = typer.Typer(help="Run Kimi Code CLI web interface.")


def resolve_npm() -> str | None:
    candidates = ["npm"]
    if os.name == "nt":
        candidates.extend(["npm.cmd", "npm.exe", "npm.bat"])
    for candidate in candidates:
        npm = shutil.which(candidate)
        if npm:
            return npm
    return None


def run_npm(npm: str, args: list[str]) -> int:
    try:
        result = subprocess.run([npm, *args], check=False)
    except FileNotFoundError:
        print(
            "npm not found or failed to execute. Install Node.js (npm) and ensure it is on PATH.",
            file=sys.stderr,
        )
        return 1
    return int(result.returncode)


def build_web_ui(root: Path) -> int:
    web_dir = root / "web"
    dist_dir = web_dir / "dist"
    node_modules = web_dir / "node_modules"
    static_dir = root / "src" / "kimi_cli" / "web" / "static"
    strict_version = os.environ.get("KIMI_WEB_STRICT_VERSION", "").lower() in {"1", "true", "yes"}
    required_web_type_files = (
        node_modules / "vite" / "client.d.ts",
        node_modules / "@types" / "node" / "index.d.ts",
    )

    npm = resolve_npm()
    if npm is None:
        print("npm not found. Install Node.js (npm) to build the web UI.", file=sys.stderr)
        return 1

    pyproject = root / "pyproject.toml"
    if not pyproject.exists():
        print(f"pyproject.toml not found under {root}", file=sys.stderr)
        return 1

    with pyproject.open("rb") as handle:
        project_data = tomllib.load(handle)
    expected_version = str(project_data["project"]["version"])
    explicit_expected = os.environ.get("KIMI_WEB_EXPECT_VERSION")
    if explicit_expected and explicit_expected != expected_version:
        print(
            f"web version mismatch: pyproject={expected_version}, expected={explicit_expected}",
            file=sys.stderr,
        )
        return 1

    def has_required_web_type_files() -> bool:
        return all(path.is_file() for path in required_web_type_files)

    needs_install = (not node_modules.exists()) or (not has_required_web_type_files())
    if needs_install:
        if node_modules.exists():
            print("web dependencies are incomplete; reinstalling with devDependencies...")
        returncode = run_npm(npm, ["--prefix", str(web_dir), "ci", "--include=dev"])
        if returncode != 0:
            return returncode

    returncode = run_npm(npm, ["--prefix", str(web_dir), "run", "build"])
    if returncode != 0:
        return returncode

    if not dist_dir.exists():
        print("web/dist not found after build. Check the web build output.", file=sys.stderr)
        return 1

    def find_version_in_dist(version: str) -> bool:
        search_suffixes = {".js", ".css", ".html", ".map"}
        version_with_prefix = f"v{version}"
        found_plain = False
        for path in dist_dir.rglob("*"):
            if not path.is_file() or path.suffix not in search_suffixes:
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if version_with_prefix in content:
                return True
            if version in content:
                found_plain = True
        return found_plain

    if strict_version and not find_version_in_dist(expected_version):
        print(
            f"web version not found in build output; expected version {expected_version}",
            file=sys.stderr,
        )
        return 1

    if static_dir.exists():
        shutil.rmtree(static_dir)
    static_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(dist_dir, static_dir)

    print(f"Synced web UI to {static_dir}")
    return 0


@cli.callback(invoke_without_command=True)
def web(
    ctx: typer.Context,
    host: Annotated[
        str | None,
        typer.Option("--host", "-h", help="Bind to specific IP address"),
    ] = None,
    network: Annotated[
        bool,
        typer.Option("--network", "-n", help="Enable network access (bind to 0.0.0.0)"),
    ] = False,
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind to")] = 5494,
    reload: Annotated[bool, typer.Option("--reload", help="Enable auto-reload")] = False,
    open_browser: Annotated[
        bool, typer.Option("--open/--no-open", help="Open browser automatically")
    ] = True,
    auth_token: Annotated[
        str | None,
        typer.Option("--auth-token", help="Bearer token for API authentication."),
    ] = None,
    allowed_origins: Annotated[
        str | None,
        typer.Option(
            "--allowed-origins",
            help="Comma-separated list of allowed Origin values.",
        ),
    ] = None,
    dangerously_omit_auth: Annotated[
        bool,
        typer.Option(
            "--dangerously-omit-auth",
            help="Disable auth checks (dangerous in public networks).",
        ),
    ] = False,
    restrict_sensitive_apis: Annotated[
        bool | None,
        typer.Option(
            "--restrict-sensitive-apis/--no-restrict-sensitive-apis",
            help="Disable sensitive APIs (config write, open-in, file access limits).",
        ),
    ] = None,
    lan_only: Annotated[
        bool,
        typer.Option(
            "--lan-only/--public",
            help="Only allow access from local network (default) or allow public access.",
        ),
    ] = True,
):
    """Run Kimi Code CLI web interface."""
    from kimi_cli.web.app import run_web_server

    # Determine bind address
    if host:
        bind_host = host
    elif network:
        bind_host = "0.0.0.0"
    else:
        bind_host = "127.0.0.1"

    run_web_server(
        host=bind_host,
        port=port,
        reload=reload,
        open_browser=open_browser,
        auth_token=auth_token,
        allowed_origins=allowed_origins,
        dangerously_omit_auth=dangerously_omit_auth,
        restrict_sensitive_apis=restrict_sensitive_apis,
        lan_only=lan_only,
    )


@cli.command()
def build(
    root: Annotated[
        Path,
        typer.Option("--root", help="Repository root containing web/ and pyproject.toml"),
    ] = Path("."),
):
    """Build and sync the web UI into src/kimi_cli/web/static"""
    import sys
    
    result = build_web_ui(root.resolve())
    sys.exit(result)
