"""Normalize proxy environment variables for httpx/aiohttp compatibility."""

from __future__ import annotations

import os

_PROXY_ENV_VARS = (
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
)

_SOCKS_PREFIX = "socks://"
_SOCKS5_PREFIX = "socks5://"


def normalize_proxy_env() -> None:
    """Rewrite ``socks://`` to ``socks5://`` in proxy environment variables.

    Many proxy tools (V2RayN, Clash, etc.) set ``ALL_PROXY=socks://...``, but
    httpx and aiohttp only recognise ``socks5://``.  Since ``socks://`` is
    effectively an alias for ``socks5://``, this function performs a safe
    in-place replacement so that downstream HTTP clients work correctly.
    """
    for var in _PROXY_ENV_VARS:
        value = os.environ.get(var)
        if value is not None and value.lower().startswith(_SOCKS_PREFIX):
            os.environ[var] = _SOCKS5_PREFIX + value[len(_SOCKS_PREFIX) :]
