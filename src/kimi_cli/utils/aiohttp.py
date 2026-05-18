from __future__ import annotations

import asyncio
import atexit
import contextlib
import ssl
import threading
import warnings
from typing import Final

import aiohttp
import certifi

_ssl_context = ssl.create_default_context(cafile=certifi.where())

_DEFAULT_TIMEOUT = aiohttp.ClientTimeout(
    total=120,
    sock_read=60,
    sock_connect=15,
)

_DEFAULT_POOL_LIMIT: Final = 100
_DEFAULT_POOL_LIMIT_PER_HOST: Final = 30
_DEFAULT_DNS_CACHE_TTL: Final = 300


class _ConnectionPool:
    """Thread-safe lazy-initialised connection pool for aiohttp.

    Each event loop gets its own :class:`aiohttp.TCPConnector` so that
    concurrent loops (e.g. from different threads or sequential
    ``asyncio.run()`` calls) never invalidate one another.

    Connectors belonging to closed event loops are reaped automatically
    when a new connector is created.  HTTP keep-alive therefore works
    across multiple ``async with`` blocks as long as the same loop is
    used.
    """

    def __init__(
        self,
        *,
        limit: int = _DEFAULT_POOL_LIMIT,
        limit_per_host: int = _DEFAULT_POOL_LIMIT_PER_HOST,
        ttl_dns_cache: int = _DEFAULT_DNS_CACHE_TTL,
        register_atexit: bool = True,
    ) -> None:
        self._limit = limit
        self._limit_per_host = limit_per_host
        self._ttl_dns_cache = ttl_dns_cache
        # Map id(loop) -> (loop, connector).  We store a strong reference
        # to the loop alongside the connector so that id(loop) stays
        # stable as a dict key until we explicitly reap the entry.
        self._connectors: dict[int, tuple[asyncio.AbstractEventLoop, aiohttp.TCPConnector]] = {}
        self._lock = threading.Lock()
        self._atexit_registered: bool = False
        self._register_atexit = register_atexit

    def get_connector(self) -> aiohttp.TCPConnector:
        """Return a connector bound to the current event loop, creating one if necessary."""
        loop = asyncio.get_running_loop()
        loop_id = id(loop)

        with self._lock:
            # Fast path: already have a live connector for this loop.
            entry = self._connectors.get(loop_id)
            if entry is not None:
                stored_loop, connector = entry
                if not connector.closed and not stored_loop.is_closed():
                    return connector

            # Slow path: reap stale connectors, then create.
            # Reap connectors whose event loop has been closed.
            stale_ids = [
                lid for lid, (sl, c) in self._connectors.items() if c.closed or sl.is_closed()
            ]
            for lid in stale_ids:
                _, old = self._connectors.pop(lid, (None, None))
                if old is not None and not old.closed:
                    with contextlib.suppress(Exception):
                        # Best-effort synchronous close — same path aiohttp
                        # uses internally in BaseConnector.__del__.  On a
                        # dead loop this may raise, in which case GC will
                        # reclaim the object.
                        old._close()  # type: ignore[reportPrivateUsage]

            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore", category=DeprecationWarning, module="aiohttp.connector"
                )
                connector = aiohttp.TCPConnector(
                    ssl=_ssl_context,
                    limit=self._limit,
                    limit_per_host=self._limit_per_host,
                    ttl_dns_cache=self._ttl_dns_cache,
                    # On affected CPython versions aiohttp needs a periodic
                    # callback to reap SSL transports closed by the remote
                    # peer.  aiohttp ignores the flag on versions that do
                    # not need it, so we always pass it.
                    enable_cleanup_closed=True,
                )
            self._connectors[loop_id] = (loop, connector)

            if self._register_atexit and not self._atexit_registered:
                atexit.register(self._sync_close)
                self._atexit_registered = True

        return connector

    def new_session(
        self,
        *,
        timeout: aiohttp.ClientTimeout | None = None,
    ) -> aiohttp.ClientSession:
        """Create a new client session backed by this pool."""
        return aiohttp.ClientSession(
            connector=self.get_connector(),
            connector_owner=False,
            timeout=timeout or _DEFAULT_TIMEOUT,
        )

    async def close(self) -> None:
        """Close all connectors.  Safe to call multiple times."""
        connectors: list[tuple[asyncio.AbstractEventLoop, aiohttp.TCPConnector]] = []
        with self._lock:
            connectors.extend(self._connectors.values())
            self._connectors.clear()
            if self._atexit_registered:
                atexit.unregister(self._sync_close)
                self._atexit_registered = False
        current_loop = asyncio.get_running_loop()
        for loop, c in connectors:
            if c.closed:
                continue
            if loop is current_loop and not loop.is_closed():
                await c.close()
            else:
                # Close connectors from dead/other loops synchronously to
                # avoid cross-loop task/future errors.
                with contextlib.suppress(Exception):
                    c._close()  # type: ignore[reportPrivateUsage]

    def _sync_close(self) -> None:
        """Synchronous best-effort cleanup for atexit.

        On process exit the OS reclaims any remaining file descriptors,
        so we simply drop the references rather than risk interacting
        with a partially-torn-down event loop.
        """
        with self._lock:
            self._connectors.clear()


# Module-level default pool used by all callers.
_default_pool = _ConnectionPool()


def new_client_session(
    *,
    timeout: aiohttp.ClientTimeout | None = None,
) -> aiohttp.ClientSession:
    """Create a new client session backed by the default connection pool.

    The returned session must be used as an async context manager
    (``async with``).  The underlying TCPConnector is shared (per event
    loop) and kept open across sessions so that HTTP keep-alive works.
    """
    return _default_pool.new_session(timeout=timeout)


async def close_connector() -> None:
    """Close the default shared connectors.  Safe to call multiple times."""
    await _default_pool.close()
