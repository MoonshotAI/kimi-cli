"""Web UI command for Kimi Code CLI."""

from typing import Annotated

import typer

cli = typer.Typer(help="Run Kimi Code CLI web interface.")


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
