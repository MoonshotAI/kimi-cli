from __future__ import annotations

import ssl

import aiohttp
import certifi

_ssl_context = ssl.create_default_context(cafile=certifi.where())


def new_client_session() -> aiohttp.ClientSession:
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=_ssl_context))
