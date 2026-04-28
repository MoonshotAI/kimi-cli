"""Kimi Code CLI Web UI application."""

import os
import secrets
import sys
import webbrowser
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.responses import HTMLResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from kimi_cli import logger
from kimi_cli.utils.server import (
    find_available_port,
    format_url,
    get_network_addresses,
    is_local_host,
)
from kimi_cli.web.api import (
    config_router,
    open_in_router,
    sessions_router,
    work_dirs_router,
)
from kimi_cli.web.auth import (
    DEFAULT_ALLOWED_ORIGIN_REGEX,
    AuthMiddleware,
    is_private_ip,
    normalize_allowed_origins,
)
from kimi_cli.web.runner.process import KimiCLIRunner

# Configure logging based on LOG_LEVEL environment variable
_log_level = os.environ.get("LOG_LEVEL", "WARNING").upper()
logger.remove()
logger.enable("kimi_cli")
logger.add(sys.stderr, level=_log_level)


def _get_scalar_api_reference() -> Callable[..., HTMLResponse] | None:
    """Import scalar-fastapi lazily.

    scalar-fastapi does not ship typing stubs, and importing it at module import
    time makes the whole Web UI fail if that optional dependency is broken.

    Keeping this as a best-effort import keeps `/healthz` and the Web UI working
    even if the docs UI is unavailable.
    """

    try:
        import scalar_fastapi  # type: ignore[import-not-found]
    except Exception as e:
        logger.warning(f"Failed to import scalar_fastapi; disabling /docs: {e}")
        return None

    return cast(  # pyright: ignore[reportUnknownMemberType]
        Callable[..., HTMLResponse],
        scalar_fastapi.get_scalar_api_reference,  # pyright: ignore[reportUnknownMemberType]
    )


def _docs_unavailable_response() -> HTMLResponse:
    return HTMLResponse(
        "Docs UI is unavailable (failed to import scalar-fastapi).",
        status_code=503,
    )


# Constants
STATIC_DIR = Path(__file__).parent / "static"
GZIP_MINIMUM_SIZE = 1024
GZIP_COMPRESSION_LEVEL = 6
DEFAULT_PORT = 5494
MAX_PORT_ATTEMPTS = 10
ENV_SESSION_TOKEN = "KIMI_WEB_SESSION_TOKEN"
ENV_ALLOWED_ORIGINS = "KIMI_WEB_ALLOWED_ORIGINS"
ENV_ENFORCE_ORIGIN = "KIMI_WEB_ENFORCE_ORIGIN"
ENV_RESTRICT_SENSITIVE_APIS = "KIMI_WEB_RESTRICT_SENSITIVE_APIS"
ENV_MAX_PUBLIC_PATH_DEPTH = "KIMI_WEB_MAX_PUBLIC_PATH_DEPTH"

# Cache durations
_IMMUTABLE_MAX_AGE = 365 * 24 * 3600  # 1 year for content-hashed assets


class _StaticCacheHeadersMiddleware:
    """Inject Cache-Control headers for static assets served by Starlette.

    * ``index.html`` (and any non-hashed HTML) → ``no-cache`` so the browser
      always revalidates, preventing stale references to renamed chunks after a
      CLI upgrade (see #1602).
    * Hashed assets under ``/assets/`` → long-lived ``immutable`` cache because
      the content hash in the filename already guarantees uniqueness.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")

        async def _send_with_cache_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if path.startswith("/assets/"):
                    headers["cache-control"] = f"public, max-age={_IMMUTABLE_MAX_AGE}, immutable"
                elif path == "/" or path.endswith(".html"):
                    headers["cache-control"] = "no-cache, no-store, must-revalidate"
            await send(message)

        await self.app(scope, receive, _send_with_cache_headers)


def _get_private_addresses(addresses: list[str]) -> list[str]:
    """Filter addresses to only include private IPs."""
    return [ip for ip in addresses if is_private_ip(ip)]


def _load_env_flag(key: str) -> bool:
    return os.environ.get(key, "").strip().lower() in {"1", "true", "yes", "on"}


ENV_LAN_ONLY = "KIMI_WEB_LAN_ONLY"


def create_app(
    session_token: str | None = None,
    allowed_origins: list[str] | None = None,
    enforce_origin: bool | None = None,
    restrict_sensitive_apis: bool | None = None,
    max_public_path_depth: int | None = None,
    lan_only: bool | None = None,
) -> FastAPI:
    """Create the FastAPI application for Kimi CLI web UI."""

    env_token = os.environ.get(ENV_SESSION_TOKEN) or None
    env_origins = normalize_allowed_origins(os.environ.get(ENV_ALLOWED_ORIGINS))
    env_enforce_origin = _load_env_flag(ENV_ENFORCE_ORIGIN)
    env_restrict_sensitive = _load_env_flag(ENV_RESTRICT_SENSITIVE_APIS)
    env_max_depth_str = os.environ.get(ENV_MAX_PUBLIC_PATH_DEPTH)
    env_max_depth = (
        int(env_max_depth_str) if env_max_depth_str and env_max_depth_str.isdigit() else None
    )
    env_lan_only = _load_env_flag(ENV_LAN_ONLY)

    session_token = session_token if session_token is not None else env_token
    allowed_origins = allowed_origins if allowed_origins is not None else env_origins
    enforce_origin = enforce_origin if enforce_origin is not None else env_enforce_origin
    restrict_sensitive_apis = (
        restrict_sensitive_apis if restrict_sensitive_apis is not None else env_restrict_sensitive
    )
    max_public_path_depth = (
        max_public_path_depth if max_public_path_depth is not None else env_max_depth
    )
    lan_only = lan_only if lan_only is not None else env_lan_only

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.startup_dir = os.getcwd()
        app.state.session_token = session_token
        app.state.allowed_origins = allowed_origins
        app.state.enforce_origin = enforce_origin
        app.state.restrict_sensitive_apis = restrict_sensitive_apis
        app.state.max_public_path_depth = max_public_path_depth
        app.state.lan_only = lan_only

        # Start KimiCLI runner
        runner = KimiCLIRunner()
        app.state.runner = runner
        runner.start()

        try:
            yield
        finally:
            await runner.stop()

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

    application.add_middleware(cast(Any, _StaticCacheHeadersMiddleware))

    application.add_middleware(
        cast(Any, AuthMiddleware),
        session_token=session_token,
        allowed_origins=allowed_origins,
        enforce_origin=enforce_origin,
        lan_only=lan_only,
    )

    cors_kwargs: dict[str, Any] = {
        "allow_credentials": True,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
    }
    if allowed_origins:
        cors_kwargs["allow_origins"] = allowed_origins
    else:
        cors_kwargs["allow_origin_regex"] = DEFAULT_ALLOWED_ORIGIN_REGEX.pattern

    # CORS middleware for local development
    application.add_middleware(cast(Any, CORSMiddleware), **cors_kwargs)

    application.include_router(config_router)
    application.include_router(sessions_router)
    application.include_router(work_dirs_router)
    if not restrict_sensitive_apis:
        application.include_router(open_in_router)

    @application.get("/scalar", include_in_schema=False)
    @application.get("/docs", include_in_schema=False)
    async def scalar_html() -> HTMLResponse:  # pyright: ignore[reportUnusedFunction]
        get_scalar_api_reference = _get_scalar_api_reference()
        if get_scalar_api_reference is None:
            return _docs_unavailable_response()

        return get_scalar_api_reference(
            openapi_url=application.openapi_url or "", title=application.title
        )

    @application.get("/healthz")
    async def health_probe() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        """Health check endpoint."""
        return {"status": "ok"}

    # Mount static files as fallback (must be last)
    if STATIC_DIR.exists():
        application.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return application


def run_web_server(
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    reload: bool = False,
    open_browser: bool = True,
    auth_token: str | None = None,
    allowed_origins: str | None = None,
    dangerously_omit_auth: bool = False,
    restrict_sensitive_apis: bool | None = None,
    lan_only: bool = True,
) -> None:
    """Run the web server."""
    import sys
    import threading

    import uvicorn

    from kimi_cli.utils.server import print_banner

    public_mode = not is_local_host(host)
    parsed_allowed_origins = normalize_allowed_origins(allowed_origins)
    auto_populate_origins = public_mode and not parsed_allowed_origins

    if restrict_sensitive_apis is None:
        # Only restrict sensitive APIs in public mode (non-LAN-only)
        restrict_sensitive_apis = public_mode and not lan_only

    if public_mode and dangerously_omit_auth:
        warning_lines = [
            "SECURITY WARNING",
            "",
            "Authentication is DISABLED while running on a public host.",
            "Anyone on the network can access your sessions and files.",
            "",
            "Type 'I UNDERSTAND THE RISKS' to continue:",
        ]
        print_banner(warning_lines)
        if not sys.stdin.isatty():
            raise RuntimeError("Refusing to start without auth in non-interactive mode.")
        response = input("> ").strip()
        if response != "I UNDERSTAND THE RISKS":
            raise RuntimeError("Aborted by user.")

    if dangerously_omit_auth:
        session_token = None
    elif auth_token:
        session_token = auth_token
    elif public_mode:
        session_token = secrets.token_urlsafe(32)
    else:
        session_token = None

    if session_token:
        os.environ[ENV_SESSION_TOKEN] = session_token
    else:
        os.environ.pop(ENV_SESSION_TOKEN, None)

    # Find available port first (needed for auto-populating origins)
    actual_port = find_available_port(host, port)
    if actual_port != port:
        print(f"Port {port} is in use, using port {actual_port} instead")

    # Auto-populate allowed origins with detected network addresses + port
    if auto_populate_origins:
        auto_origins = [
            f"http://localhost:{actual_port}",
            f"http://127.0.0.1:{actual_port}",
        ]
        if host == "0.0.0.0":
            # Binding to all interfaces: add all network addresses
            network_addrs = get_network_addresses()
            for addr in network_addrs:
                auto_origins.append(format_url(addr, actual_port))
        else:
            # Explicit host specified: only add that host
            auto_origins.append(format_url(host, actual_port))
        parsed_allowed_origins = auto_origins

    if parsed_allowed_origins:
        os.environ[ENV_ALLOWED_ORIGINS] = ",".join(parsed_allowed_origins)
    else:
        os.environ.pop(ENV_ALLOWED_ORIGINS, None)

    os.environ[ENV_ENFORCE_ORIGIN] = "1" if (public_mode and not lan_only) else "0"
    os.environ[ENV_RESTRICT_SENSITIVE_APIS] = "1" if restrict_sensitive_apis else "0"
    os.environ[ENV_LAN_ONLY] = "1" if lan_only else "0"

    # Determine display URLs
    display_hosts: list[tuple[str, str]] = []
    if host == "0.0.0.0":
        # Show localhost as "Local" and network interfaces
        display_hosts.append(("Local", "localhost"))
        network_addrs = get_network_addresses()

        # In lan_only mode, only show private IPs
        if lan_only:
            network_addrs = _get_private_addresses(network_addrs)

        for addr in network_addrs:
            display_hosts.append(("Network", addr))
    else:
        # Show the specified host
        label = "Local" if is_local_host(host) else "Network"
        display_hosts.append((label, host))

    # Build URLs with token if needed
    def make_url(host_addr: str) -> tuple[str, str]:
        """Returns (url, browser_url) tuple."""
        url = format_url(host_addr, actual_port)
        browser_url = f"{url}/?token={quote(session_token)}" if session_token else url
        return url, browser_url

    # For browser opening, prefer localhost, then first network address
    browser_host = "localhost" if host == "0.0.0.0" else host
    _, browser_url = make_url(browser_host)

    if open_browser:

        def open_browser_after_delay():
            import time

            time.sleep(1.5)
            webbrowser.open(browser_url)

        # Start browser opener in a daemon thread
        thread = threading.Thread(target=open_browser_after_delay, daemon=True)
        thread.start()

    banner_lines = [
        "<center>██╗  ██╗██╗███╗   ███╗██╗     ██████╗ ██████╗ ██████╗ ███████╗",
        "<center>██║ ██╔╝██║████╗ ████║██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
        "<center>█████╔╝ ██║██╔████╔██║██║    ██║     ██║   ██║██║  ██║█████╗  ",
        "<center>██╔═██╗ ██║██║╚██╔╝██║██║    ██║     ██║   ██║██║  ██║██╔══╝  ",
        "<center>██║  ██╗██║██║ ╚═╝ ██║██║    ╚██████╗╚██████╔╝██████╔╝███████╗",
        "<center>╚═╝  ╚═╝╚═╝╚═╝     ╚═╝╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
        "",
        "<center>WEB UI (Technical Preview)",
        "",
        "<hr>",
        "",
    ]

    # Add URLs for each host (nowrap to keep URLs on single line for easy copying)
    for label, host_addr in display_hosts:
        url, url_with_token = make_url(host_addr)
        if session_token:
            banner_lines.append(f"<nowrap>  ➜  {label:8} {url_with_token}")
        else:
            banner_lines.append(f"<nowrap>  ➜  {label:8} {url}")

    # Auth token or warnings
    if session_token:
        banner_lines.extend(
            [
                "",
                f"<nowrap>  Token:   {session_token}",
            ]
        )
    elif public_mode:
        banner_lines.extend(
            [
                "",
                "<nowrap>  ⚠ AUTH DISABLED - Anyone on the network can access",
            ]
        )

    if restrict_sensitive_apis:
        banner_lines.append("<nowrap>  ⚠ Sensitive APIs are restricted")

    # Show network access mode and tips
    banner_lines.append("")
    banner_lines.append("<hr>")
    banner_lines.append("")

    if not public_mode:
        # Local-only mode (127.0.0.1)
        banner_lines.extend(
            [
                "<nowrap>  Tips:",
                "<nowrap>    • Use -n / --network to share on LAN",
                "<nowrap>    • Use --network --public for public access",
            ]
        )
    elif lan_only:
        # LAN mode (0.0.0.0 with lan_only)
        banner_lines.extend(
            [
                "<nowrap>  Mode: LAN only (private IPs)",
                "",
                "<nowrap>  Tips:",
                "<nowrap>    • Use --public to allow public access",
                "<nowrap>    • ⚠ Public mode allows access from any IP",
            ]
        )
    else:
        # Public mode (0.0.0.0 without lan_only)
        banner_lines.extend(
            [
                "<nowrap>  ⚠ Mode: PUBLIC (all networks)",
                "<nowrap>    Anyone with the URL can access this instance",
                "",
                "<nowrap>  Security tips:",
                "<nowrap>    • Keep your auth token secure",
                "<nowrap>    • Consider using firewall or VPN",
            ]
        )

    banner_lines.append("")

    print_banner(banner_lines)
    # print(f"API docs available at {url}/docs")

    uvicorn.run(
        "kimi_cli.web.app:create_app",
        factory=True,
        host=host,
        port=actual_port,
        reload=reload,
        log_level="info",
        timeout_graceful_shutdown=3,
    )


__all__ = ["create_app", "run_web_server"]
