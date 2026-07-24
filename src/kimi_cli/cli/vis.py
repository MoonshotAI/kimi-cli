"""Vis command for Kimi Agent Tracing Visualizer."""

from typing import Annotated

import typer

cli = typer.Typer(help="Run Kimi Agent Tracing Visualizer.")


@cli.callback(invoke_without_command=True)
def vis(
    ctx: typer.Context,
    host: Annotated[
        str | None,
        typer.Option("--host", "-h", help="Bind to specific IP address"),
    ] = None,
    network: Annotated[
        bool,
        typer.Option("--network", "-n", help="Enable network access (bind to 0.0.0.0)"),
    ] = False,
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind to")] = 5495,
    open_browser: Annotated[
        bool, typer.Option("--open/--no-open", help="Open browser automatically")
    ] = True,
    reload: Annotated[bool, typer.Option("--reload", help="Enable auto-reload")] = False,
):
    """Launch the agent tracing visualizer."""
    from kimi_cli.vis.app import run_vis_server

    # Determine bind address (same logic as kimi web)
    if host:
        bind_host = host
    elif network:
        bind_host = "0.0.0.0"
    else:
        bind_host = "127.0.0.1"

    run_vis_server(host=bind_host, port=port, open_browser=open_browser, reload=reload)
