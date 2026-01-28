from __future__ import annotations

import os
import ssl

import aiohttp
import certifi

# Standard environment variable for custom CA certificates.
# Used by corporate proxies (e.g., Zscaler) and other enterprise environments.
# See: https://docs.python.org/3/library/ssl.html#ssl.SSLContext.load_verify_locations
_SSL_CERT_FILE_ENV = "SSL_CERT_FILE"


def _get_ssl_ca_file() -> str:
    """
    Get the CA certificate file path for SSL verification.

    Respects the standard SSL_CERT_FILE environment variable, allowing users
    behind corporate proxies (e.g., Zscaler) to use their custom CA bundles.
    Falls back to certifi's bundled certificates if the environment variable
    is not set.

    Returns:
        Path to the CA certificate file.
    """
    return os.environ.get(_SSL_CERT_FILE_ENV) or certifi.where()


_ssl_context = ssl.create_default_context(cafile=_get_ssl_ca_file())


def new_client_session() -> aiohttp.ClientSession:
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=_ssl_context))
