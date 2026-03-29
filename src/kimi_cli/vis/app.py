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


def _get_address_family(host: str) -> socket.AddressFamily:
    """Return AF_INET6 for IPv6 addresses, AF_INET otherwise."""
    return socket.AF_INET6 if ":" in host else socket.AF_INET


def find_available_port(host: str, start_port: int, max_attempts: int = MAX_PORT_ATTEMPTS) -> int:
    """Find an available port starting from start_port."""
    family = _get_address_family(host)
    for offset in range(max_attempts):
        port = start_port + offset
        with socket.socket(family, socket.SOCK_STREAM) as s:
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


def _is_local_host(host: str) -> bool:
    return host in {"127.0.0.1", "localhost", "::1"}


def _get_network_addresses() -> list[str]:
    """Get non-loopback IPv4 addresses for this machine."""
    import importlib

    addresses: list[str] = []

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if isinstance(ip, str) and not ip.startswith("127.") and ip not in addresses:
                addresses.append(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        if ip and not ip.startswith("127.") and ip not in addresses:
            addresses.append(ip)
    except OSError:
        pass

    try:
        netifaces = importlib.import_module("netifaces")
        for interface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(interface)
            if netifaces.AF_INET in addrs:
                for addr_info in addrs[netifaces.AF_INET]:
                    addr = addr_info.get("addr")
                    if addr and not addr.startswith("127.") and addr not in addresses:
                        addresses.append(addr)
    except (ImportError, Exception):
        pass

    return addresses


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

    public_mode = not _is_local_host(host)

    # Build display hosts (same logic as kimi web)
    display_hosts: list[tuple[str, str]] = []
    if host == "0.0.0.0":
        display_hosts.append(("Local", "localhost"))
        for addr in _get_network_addresses():
            display_hosts.append(("Network", addr))
    else:
        label = "Local" if _is_local_host(host) else "Network"
        display_hosts.append((label, host))

    # Browser should open localhost
    browser_host = "localhost" if host == "0.0.0.0" else host
    browser_url = f"http://{browser_host}:{actual_port}"

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
        banner_lines.append(f"<nowrap>  ➜  {label:8} http://{host_addr}:{actual_port}")

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

    _print_banner(banner_lines)

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


__all__ = ["create_app", "find_available_port", "run_vis_server"]
