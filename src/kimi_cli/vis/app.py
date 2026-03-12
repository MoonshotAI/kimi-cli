"""Kimi Agent Tracing Visualizer application."""

from __future__ import annotations

import socket
import webbrowser
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from kimi_cli.vis.api import sessions_router, statistics_router, system_router
from kimi_cli.web.api.open_in import router as open_in_router

STATIC_DIR = Path(__file__).parent / "static"
GZIP_MINIMUM_SIZE = 1024
GZIP_COMPRESSION_LEVEL = 6
DEFAULT_PORT = 5495
MAX_PORT_ATTEMPTS = 10


def create_app() -> FastAPI:
    """Create the FastAPI application for the tracing visualizer."""
    application = FastAPI(
        title="Kimi Agent Tracing Visualizer",
        docs_url=None,
        separate_input_output_schemas=False,
    )

    application.add_middleware(
        cast(Any, GZipMiddleware),
        minimum_size=GZIP_MINIMUM_SIZE,
        compresslevel=GZIP_COMPRESSION_LEVEL,
    )

    application.add_middleware(
        cast(Any, CORSMiddleware),
        allow_origins=["*"],  # Local-only tool; port is dynamic so wildcard is acceptable
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(sessions_router)
    application.include_router(statistics_router)
    application.include_router(system_router)
    application.include_router(open_in_router)

    @application.get("/healthz")
    async def health_probe() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        return {"status": "ok"}

    if STATIC_DIR.exists():
        application.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return application


def find_available_port(host: str, start_port: int, max_attempts: int = MAX_PORT_ATTEMPTS) -> int:
    """Find an available port starting from start_port."""
    for offset in range(max_attempts):
        port = start_port + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(
        f"Cannot find available port in range {start_port}-{start_port + max_attempts - 1}"
    )


def _print_banner(lines: list[str]) -> None:
    """Print a boxed banner, reusing the same tag conventions as kimi web."""
    import textwrap

    processed: list[str] = []
    for line in lines:
        if line == "<hr>":
            processed.append(line)
        elif not line:
            processed.append("")
        elif line.startswith("<center>") or line.startswith("<nowrap>"):
            processed.append(line)
        else:
            processed.extend(textwrap.wrap(line, width=78))

    def strip_tags(s: str) -> str:
        return s.removeprefix("<center>").removeprefix("<nowrap>")

    content_lines = [strip_tags(line) for line in processed if line != "<hr>"]
    width = max(60, *(len(line) for line in content_lines))
    top = "+" + "=" * (width + 2) + "+"

    print(top)
    for line in processed:
        if line == "<hr>":
            print("|" + "-" * (width + 2) + "|")
        elif line.startswith("<center>"):
            content = line.removeprefix("<center>")
            print(f"| {content.center(width)} |")
        elif line.startswith("<nowrap>"):
            content = line.removeprefix("<nowrap>")
            print(f"| {content.ljust(width)} |")
        else:
            print(f"| {line.ljust(width)} |")
    print(top)


def run_vis_server(
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    reload: bool = False,
    open_browser: bool = True,
) -> None:
    """Run the visualizer web server."""
    import threading

    import uvicorn

    actual_port = find_available_port(host, port)
    if actual_port != port:
        print(f"\nPort {port} is in use, using port {actual_port} instead")

    url = f"http://{host}:{actual_port}"

    banner_lines = [
        "<center>██╗  ██╗██╗███╗   ███╗██╗    ██╗   ██╗██╗███████╗",
        "<center>██║ ██╔╝██║████╗ ████║██║    ██║   ██║██║██╔════╝",
        "<center>█████╔╝ ██║██╔████╔██║██║    ██║   ██║██║███████╗",
        "<center>██╔═██╗ ██║██║╚██╔╝██║██║    ╚██╗ ██╔╝██║╚════██║",
        "<center>██║  ██╗██║██║ ╚═╝ ██║██║     ╚████╔╝ ██║███████║",
        "<center>╚═╝  ╚═╝╚═╝╚═╝     ╚═╝╚═╝      ╚═══╝  ╚═╝╚══════╝",
        "",
        "<center>AGENT TRACING VISUALIZER (Technical Preview)",
        "",
        "<hr>",
        "",
        f"<nowrap>  ➜  Local    {url}",
        "",
        "<hr>",
        "",
        "<nowrap>  This feature is in Technical Preview and may be unstable.",
        "<nowrap>  Please report issues to the kimi-cli team.",
        "",
    ]

    _print_banner(banner_lines)

    if open_browser:

        def open_browser_after_delay() -> None:
            import time

            time.sleep(1.5)
            webbrowser.open(url)

        thread = threading.Thread(target=open_browser_after_delay, daemon=True)
        thread.start()

    uvicorn.run(
        "kimi_cli.vis.app:create_app",
        factory=True,
        host=host,
        port=actual_port,
        reload=reload,
        log_level="info",
        timeout_graceful_shutdown=3,
    )


__all__ = ["create_app", "find_available_port", "run_vis_server"]
