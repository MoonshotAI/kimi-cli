"""Auth helpers and middleware for Kimi CLI web."""

from __future__ import annotations

import hmac
import ipaddress
import re
from collections.abc import Iterable

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

DEFAULT_ALLOWED_ORIGIN_REGEX = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


def timing_safe_compare(a: str, b: str) -> bool:
    """Timing-safe string comparison."""
    return hmac.compare_digest(a.encode(), b.encode())


def parse_bearer_token(value: str | None) -> str | None:
    """Extract bearer token from Authorization header."""
    if not value:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def normalize_allowed_origins(value: str | None) -> list[str]:
    """Parse comma-separated origins into a normalized list."""
    if not value:
        return []
    origins: list[str] = []
    for raw in value.split(","):
        origin = raw.strip().rstrip("/")
        if origin:
            origins.append(origin)
    return origins


def is_origin_allowed(origin: str, allowed_origins: Iterable[str] | None) -> bool:
    """Check if an origin is allowed.

    Args:
        origin: The origin to check
        allowed_origins: List of allowed origins.
                        - None: use default localhost regex
                        - Empty list: reject all origins
                        - Non-empty list: check against the list (supports "*" wildcard)
    """
    origin = origin.rstrip("/")

    # None means use default behavior (localhost only)
    if allowed_origins is None:
        return bool(DEFAULT_ALLOWED_ORIGIN_REGEX.match(origin))

    allowed = list(allowed_origins)

    # Empty list explicitly means reject all
    if not allowed:
        return False

    # Check for wildcard or exact match
    if "*" in allowed:
        return True
    return origin in allowed


def extract_token_from_request(request: Request) -> str | None:
    """Get auth token from Authorization header or query (GET-only)."""
    token = parse_bearer_token(request.headers.get("authorization"))
    if token:
        return token
    if request.method.upper() == "GET":
        query_token = request.query_params.get("token")
        if query_token:
            return query_token
    return None


def verify_token(provided: str | None, expected: str) -> bool:
    """Verify token using timing-safe comparison."""
    if not provided:
        return False
    return timing_safe_compare(provided, expected)


def is_private_ip(ip: str) -> bool:
    """Check if an IP address is in a private range (RFC 1918 + localhost).

    Supports both IPv4 and IPv6 addresses.
    """
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
        # is_private covers RFC 1918 (10.x, 172.16-31.x, 192.168.x)
        # is_loopback covers 127.x.x.x and ::1
        # is_link_local covers 169.254.x.x and fe80::/10
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        return False


def get_client_ip(request: Request, trust_proxy: bool = False) -> str | None:
    """Extract client IP from request.

    Args:
        request: The incoming request
        trust_proxy: If True, trust X-Forwarded-For header (only enable behind trusted proxy)
    """
    if trust_proxy:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    """Bearer token auth, origin checks, and LAN-only mode for API routes."""

    def __init__(
        self,
        app: ASGIApp,
        session_token: str | None,
        allowed_origins: Iterable[str] | None,
        enforce_origin: bool,
        lan_only: bool = False,
    ) -> None:
        super().__init__(app)
        self._session_token = session_token
        self._allowed_origins = list(allowed_origins) if allowed_origins is not None else None
        self._enforce_origin = enforce_origin
        self._lan_only = lan_only

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        path = request.url.path

        # LAN-only check applies to all requests (including static files)
        if self._lan_only:
            client_ip = get_client_ip(request)
            if client_ip and not is_private_ip(client_ip):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Access denied: only local network access is allowed"},
                )

        if request.method.upper() == "OPTIONS":
            return await call_next(request)
        if path in {"/healthz", "/docs", "/scalar"}:
            return await call_next(request)
        if not path.startswith("/api/"):
            return await call_next(request)

        if self._enforce_origin:
            origin = request.headers.get("origin")
            if origin and not is_origin_allowed(origin, self._allowed_origins):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Origin not allowed"},
                )

        if self._session_token:
            provided = extract_token_from_request(request)
            if not verify_token(provided, self._session_token):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Unauthorized"},
                )

        return await call_next(request)


__all__ = [
    "AuthMiddleware",
    "DEFAULT_ALLOWED_ORIGIN_REGEX",
    "extract_token_from_request",
    "get_client_ip",
    "is_origin_allowed",
    "is_private_ip",
    "normalize_allowed_origins",
    "timing_safe_compare",
    "verify_token",
]
