"""Kimi Agent Tracing Visualizer application."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from kimi_cli.utils.server import (
    find_available_port,
    format_url,
    get_network_addresses,
    is_local_host,
    print_banner,
)
from kimi_cli.vis.api import sessions_router, statistics_router, system_router
from kimi_cli.web.api.open_in import router as open_in_router

STATIC_DIR = Path(__file__).parent / "static"
GZIP_MINIMUM_SIZE = 1024
GZIP_COMPRESSION_LEVEL = 6
DEFAULT_PORT = 5495
_ENV_RESTRICT_OPEN_IN = "KIMI_VIS_RESTRICT_OPEN_IN"


def create_app() -> FastAPI:
    """Create the FastAPI application for the tracing visualizer."""
    import os

    restrict_open_in = os.environ.get(_ENV_RESTRICT_OPEN_IN, "").strip().lower() in {
        "1",
        "true",
    }

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

    application.state.restrict_open_in = restrict_open_in

    application.include_router(sessions_router)
    application.include_router(statistics_router)
    application.include_router(system_router)
    if not restrict_open_in:
        application.include_router(open_in_router)

    @application.get("/healthz")
    async def health_probe() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        return {"status": "ok"}

    if STATIC_DIR.exists():
        application.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return application


def run_vis_server(
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    reload: bool = False,
    open_browser: bool = True,
) -> None:
    """Run the visualizer web server."""
    import os
    import threading
    import webbrowser

    import uvicorn

    actual_port = find_available_port(host, port)
    if actual_port != port:
        print(f"\nPort {port} is in use, using port {actual_port} instead")

    public_mode = not is_local_host(host)

    # Disable open-in API when exposed to the network (security)
    os.environ[_ENV_RESTRICT_OPEN_IN] = "1" if public_mode else "0"

    # Build display hosts (same logic as kimi web)
    display_hosts: list[tuple[str, str]] = []
    if host == "0.0.0.0":
        display_hosts.append(("Local", "localhost"))
        for addr in get_network_addresses():
            display_hosts.append(("Network", addr))
    else:
        label = "Local" if is_local_host(host) else "Network"
        display_hosts.append((label, host))

    # Browser should open localhost
    browser_host = "localhost" if host == "0.0.0.0" else host
    browser_url = format_url(browser_host, actual_port)

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
    ]

    for label, host_addr in display_hosts:
        banner_lines.append(f"<nowrap>  ➜  {label:8} {format_url(host_addr, actual_port)}")

    banner_lines.append("")
    banner_lines.append("<hr>")
    banner_lines.append("")

    if not public_mode:
        banner_lines.extend(
            [
                "<nowrap>  Tips:",
                "<nowrap>    • Use -n / --network to share on LAN",
                "",
            ]
        )
    else:
        banner_lines.extend(
            [
                "<nowrap>  This feature is in Technical Preview and may be unstable.",
                "<nowrap>  Please report issues to the kimi-cli team.",
                "",
            ]
        )

    print_banner(banner_lines)

    if open_browser:

        def open_browser_after_delay() -> None:
            import time

            time.sleep(1.5)
            webbrowser.open(browser_url)

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


__all__ = ["create_app", "run_vis_server"]
