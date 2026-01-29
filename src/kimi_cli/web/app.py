"""Kimi Code CLI Web UI application."""

import os
import socket
import webbrowser
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast

import scalar_fastapi
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import HTMLResponse

from kimi_cli.web.api import config_router, sessions_router, work_dirs_router
from kimi_cli.web.runner.process import KimiCLIRunner

# scalar-fastapi does not ship typing stubs.
get_scalar_api_reference = cast(  # pyright: ignore[reportUnknownMemberType]
    Callable[..., HTMLResponse],
    scalar_fastapi.get_scalar_api_reference,  # pyright: ignore[reportUnknownMemberType]
)

# Constants
STATIC_DIR = Path(__file__).parent / "static"
GZIP_MINIMUM_SIZE = 1024
GZIP_COMPRESSION_LEVEL = 6
DEFAULT_PORT = 5494
MAX_PORT_ATTEMPTS = 10


def create_app() -> FastAPI:
    """Create the FastAPI application for Kimi CLI web UI."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.startup_dir = os.getcwd()

        # Start KimiCLI runner
        runner = KimiCLIRunner()
        app.state.runner = runner
        runner.start()

        try:
            yield
        finally:
            runner.stop()

    application = FastAPI(
        title="Kimi Code CLI Web Interface",
        docs_url=None,
        lifespan=lifespan,
        separate_input_output_schemas=False,
    )

    application.add_middleware(
        cast(Any, GZipMiddleware),
        minimum_size=GZIP_MINIMUM_SIZE,
        compresslevel=GZIP_COMPRESSION_LEVEL,
    )

    # CORS middleware for local development
    application.add_middleware(
        cast(Any, CORSMiddleware),
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(config_router)
    application.include_router(sessions_router)
    application.include_router(work_dirs_router)

    @application.get("/scalar", include_in_schema=False)
    @application.get("/docs", include_in_schema=False)
    async def scalar_html() -> HTMLResponse:  # pyright: ignore[reportUnusedFunction]
        return get_scalar_api_reference(
            openapi_url=application.openapi_url or "",
            title=application.title,
        )

    @application.get("/healthz")
    async def health_probe() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        """Health check endpoint."""
        return {"status": "ok"}

    # Mount static files as fallback (must be last)
    if STATIC_DIR.exists():
        application.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return application


def find_available_port(host: str, start_port: int, max_attempts: int = MAX_PORT_ATTEMPTS) -> int:
    """Find an available port starting from start_port.

    Args:
        host: Host address to bind to
        start_port: Starting port number (1-65535)
        max_attempts: Maximum number of ports to try (must be positive)

    Returns:
        An available port number

    Raises:
        ValueError: If parameters are invalid
        RuntimeError: If no available port is found within the range
    """
    if max_attempts <= 0:
        raise ValueError("max_attempts must be positive")
    if start_port < 1 or start_port > 65535:
        raise ValueError("start_port must be between 1 and 65535")

    for offset in range(max_attempts):
        port = start_port + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(
        f"Cannot find available port in range {start_port}-{start_port + max_attempts - 1}"
    )


def run_web_server(
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    reload: bool = False,
    open_browser: bool = True,
) -> None:
    """Run the web server."""
    import textwrap
    import threading

    import uvicorn

    def print_banner(lines: list[str]) -> None:
        wrapped: list[str] = []
        for line in lines:
            if line == "<hr>":
                wrapped.append(line)
                continue
            if not line:
                wrapped.append("")
                continue
            if line.startswith("<center>"):
                wrapped.append(line)
                continue
            wrapped.extend(textwrap.wrap(line, width=78))
        content_lines = [
            line.removeprefix("<center>") if line.startswith("<center>") else line
            for line in wrapped
            if line != "<hr>"
        ]
        width = max(60, *(len(line) for line in content_lines))
        top = "+" + "=" * (width + 2) + "+"
        print(top)
        for line in wrapped:
            if line == "<hr>":
                print("|" + "-" * (width + 2) + "|")
                continue
            if line.startswith("<center>"):
                content = line.removeprefix("<center>")
                print(f"| {content.center(width)} |")
                continue
            print(f"| {line.ljust(width)} |")
        print(top)

    # Find available port
    actual_port = find_available_port(host, port)
    if actual_port != port:
        print(f"Port {port} is in use, using port {actual_port} instead")

    url = f"http://{host}:{actual_port}"

    if open_browser:

        def open_browser_after_delay():
            import time

            time.sleep(1.5)
            webbrowser.open(url)

        # Start browser opener in a daemon thread
        thread = threading.Thread(target=open_browser_after_delay, daemon=True)
        thread.start()

    print_banner(
        [
            "<center>█▄▀ █ █▀▄▀█ █   █▀▀ █▀█ █▀▄ █▀▀",
            "<center>█ █ █ █ ▀ █ █   █▄▄ █▄█ █▄▀ ██▄",
            "",
            "<center>WEB (Technical Preview)",
            "",
            "<hr>",
            "",
            f"<center>{url}",
            "",
            "<center>Open the URL above in your browser",
            "<center>Please keep this process running",
            "",
            "<hr>",
            "",
            '<center>"Why use a CLI if we already invented GUIs?"',
            "",
        ]
    )
    # print(f"API docs available at {url}/docs")

    uvicorn.run(
        "kimi_cli.web.app:create_app",
        factory=True,
        host=host,
        port=actual_port,
        reload=reload,
        log_level="info",
    )


__all__ = ["create_app", "find_available_port", "run_web_server"]
