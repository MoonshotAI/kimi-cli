from __future__ import annotations

import ssl

import aiohttp
import certifi

_ssl_context = ssl.create_default_context(cafile=certifi.where())

_DEFAULT_TIMEOUT = aiohttp.ClientTimeout(
    total=120,
    sock_read=60,
    sock_connect=15,
)


def new_client_session(
    *,
    timeout: aiohttp.ClientTimeout | None = None,
) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=_ssl_context),
        timeout=timeout or _DEFAULT_TIMEOUT,
        # Honour HTTP_PROXY/HTTPS_PROXY (and NO_PROXY) from the environment, like
        # curl does. aiohttp ignores them unless trust_env is set.
        trust_env=True,
    )
