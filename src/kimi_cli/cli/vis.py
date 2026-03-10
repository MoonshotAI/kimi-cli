"""Vis command for Kimi Agent Tracing Visualizer."""

from typing import Annotated

import typer

cli = typer.Typer(help="Run Kimi Agent Tracing Visualizer.")


@cli.callback(invoke_without_command=True)
def vis(
    ctx: typer.Context,
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind to")] = 5495,
    open_browser: Annotated[
        bool, typer.Option("--open/--no-open", help="Open browser automatically")
    ] = True,
    reload: Annotated[bool, typer.Option("--reload", help="Enable auto-reload")] = False,
):
    """Launch the agent tracing visualizer."""
    from kimi_cli.vis.app import run_vis_server

    run_vis_server(port=port, open_browser=open_browser, reload=reload)
