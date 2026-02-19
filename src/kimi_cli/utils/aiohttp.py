from __future__ import annotations

import ssl

import aiohttp
import certifi

from kimi_cli.constant import USER_AGENT

_ssl_context = ssl.create_default_context(cafile=certifi.where())

# PRIVACY: Use minimal User-Agent to prevent leaking Python/aiohttp versions
_DEFAULT_HEADERS = {"User-Agent": USER_AGENT}


def new_client_session() -> aiohttp.ClientSession:
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=_ssl_context),
        headers=_DEFAULT_HEADERS,
    )
