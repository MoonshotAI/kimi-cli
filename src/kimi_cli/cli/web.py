"""Web UI command for Kimi Code CLI."""

from typing import Annotated

import typer

cli = typer.Typer(help="Run Kimi Code CLI web interface.")


@cli.callback(invoke_without_command=True)
def web(
    ctx: typer.Context,
    host: Annotated[str, typer.Option("--host", "-h", help="Host to bind to")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind to")] = 5494,
    reload: Annotated[bool, typer.Option("--reload", help="Enable auto-reload")] = False,
    open_browser: Annotated[
        bool, typer.Option("--open/--no-open", help="Open browser automatically")
    ] = True,
):
    """Run Kimi Code CLI web interface."""
    from kimi_cli.web.app import run_web_server

    run_web_server(host=host, port=port, reload=reload, open_browser=open_browser)
