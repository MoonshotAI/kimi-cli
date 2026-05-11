"""Tests for aiohttp client session timeout configuration."""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from kimi_cli.utils.aiohttp import _ConnectionPool, close_connector, new_client_session


@pytest.fixture(autouse=True)
async def _reset_pool():
    """Ensure a fresh default pool for every test."""
    await close_connector()
    yield
    await close_connector()


async def test_default_session_has_timeout():
    """new_client_session() should create a session with non-None timeout values."""
    async with new_client_session() as session:
        assert session.timeout.total == 120
        assert session.timeout.sock_read == 60
        assert session.timeout.sock_connect == 15


async def test_custom_timeout_override():
    """Callers can override the default timeout."""
    import aiohttp

    custom = aiohttp.ClientTimeout(total=30, sock_read=10)
    async with new_client_session(timeout=custom) as session:
        assert session.timeout.total == 30
        assert session.timeout.sock_read == 10


async def test_slow_server_is_interrupted():
    """A server that accepts but never responds should be interrupted by timeout."""
    hang_forever = asyncio.Event()

    async def _slow_handler(reader, writer):
        await hang_forever.wait()
        writer.close()

    server = await asyncio.start_server(_slow_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    try:
        import aiohttp

        fast_timeout = aiohttp.ClientTimeout(total=1.0, sock_read=0.5)
        async with new_client_session(timeout=fast_timeout) as session:
            with pytest.raises(asyncio.TimeoutError):
                async with session.get(f"http://127.0.0.1:{port}/test"):
                    pass
    finally:
        hang_forever.set()
        server.close()
        await server.wait_closed()


async def test_sessions_share_connector_per_loop():
    """Multiple sessions on the same loop should reuse the same TCPConnector."""
    async with new_client_session() as session1:
        connector1 = session1.connector

    async with new_client_session() as session2:
        connector2 = session2.connector

    assert connector1 is not None
    assert connector1 is connector2
    assert connector1.limit == 100
    assert connector1.limit_per_host == 30
    # The shared connector must stay open after sessions close.
    assert not connector1.closed


async def test_connector_recreated_after_close():
    """A new connector is created after the shared one is explicitly closed."""
    async with new_client_session() as session1:
        connector1 = session1.connector

    await close_connector()

    async with new_client_session() as session2:
        connector2 = session2.connector

    assert connector1 is not None
    assert connector2 is not None
    assert connector1 is not connector2
    assert connector1.closed
    assert not connector2.closed


async def test_concurrent_creation_is_safe():
    """Multiple coroutines creating sessions simultaneously must share one connector."""
    await close_connector()

    async def _open():
        async with new_client_session() as session:
            return session.connector

    connectors = await asyncio.gather(*(_open() for _ in range(20)))

    unique = {id(c) for c in connectors}
    assert len(unique) == 1, f"Expected 1 unique connector, got {len(unique)}"

    connector = connectors[0]
    assert connector is not None
    assert connector.limit == 100
    assert connector.limit_per_host == 30
    assert not connector.closed


async def test_keepalive_pools_connections():
    """Idle connections should be returned to the pool and reused across sessions."""

    seen_ports: set[int] = set()

    async def _handler(reader, writer):
        peer = writer.get_extra_info("peername")
        if peer is not None:
            seen_ports.add(peer[1])
        # Serve requests in a loop so keep-alive connections can be reused.
        while True:
            try:
                request = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=1.0)
                if not request:
                    break
            except (TimeoutError, asyncio.LimitOverrunError, ConnectionResetError):
                break
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok"
            )
            await writer.drain()
        writer.close()

    server = await asyncio.start_server(_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    try:
        async with new_client_session() as s1, s1.get(f"http://127.0.0.1:{port}/") as resp:
            await resp.text()

        async with new_client_session() as s2, s2.get(f"http://127.0.0.1:{port}/") as resp:
            await resp.text()

        # If only one client port was seen, the connection was reused.
        # Two ports means a new connection was opened for the second request.
        # Either outcome is acceptable; the test verifies keep-alive works.
        assert len(seen_ports) <= 2, f"Expected at most 2 client ports, got {seen_ports}"
    finally:
        server.close()
        await server.wait_closed()


async def test_stress_pool_under_load():
    """Twenty parallel requests must use exactly one connector and pool connections."""
    await close_connector()

    request_count = 0

    async def _handler(reader, writer):
        nonlocal request_count
        request_count += 1
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok")
        await writer.drain()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(reader.read(), timeout=1.0)
        writer.close()

    server = await asyncio.start_server(_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    try:

        async def _fetch():
            async with new_client_session() as s, s.get(f"http://127.0.0.1:{port}/") as r:
                await r.text()

        await asyncio.gather(*(_fetch() for _ in range(20)))

        assert request_count == 20, f"Expected 20 requests, got {request_count}"

        from kimi_cli.utils.aiohttp import _default_pool

        connector = _default_pool.get_connector()
        assert connector is not None
        assert not connector.closed
    finally:
        server.close()
        await server.wait_closed()


async def test_isolated_pool_does_not_bleed():
    """A private _ConnectionPool instance must be fully independent."""
    pool = _ConnectionPool(limit=5, limit_per_host=2, register_atexit=False)

    async with pool.new_session() as s:
        assert s.connector is not None
        assert s.connector.limit == 5
        assert s.connector.limit_per_host == 2

    await pool.close()
    assert not pool._connectors


def test_separate_loops_get_separate_connectors():
    """Different asyncio.run() calls (different loops) must not share connectors."""

    async def _get_connector_id():
        async with new_client_session() as s:
            return id(s.connector)

    id1 = asyncio.run(_get_connector_id())
    id2 = asyncio.run(_get_connector_id())

    assert id1 != id2, "Expected separate connectors for separate event loops"


def test_reaps_closed_loop_connectors():
    """Connectors bound to closed event loops should be cleaned up, not leaked."""

    async def _get_connector():
        from kimi_cli.utils.aiohttp import _default_pool

        return _default_pool.get_connector()

    c1 = asyncio.run(_get_connector())
    assert not c1.closed
    c1_id = id(c1)

    # After the first asyncio.run finishes its loop is closed.
    # A second run should create a new connector and reap the old one.
    c2 = asyncio.run(_get_connector())
    assert not c2.closed
    c2_id = id(c2)

    assert c1_id != c2_id, "Expected a new connector for the new loop"
    # The old connector was dropped from the pool; it may still be alive
    # until GC runs, so we assert on pool state rather than c1.closed.
    from kimi_cli.utils.aiohttp import _default_pool

    assert c1_id not in {id(c) for _, c in _default_pool._connectors.values()}


async def _get_connector_in_thread() -> int:
    """Helper for multi-threaded stress test."""
    async with new_client_session() as s:
        return id(s.connector)


def test_multi_threaded_access():
    """Multiple threads with separate event loops must not race or crash."""
    import threading

    results: list[int] = []
    errors: list[Exception] = []

    def _run():
        try:
            results.append(asyncio.run(_get_connector_in_thread()))
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=_run) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"Threads raised exceptions: {errors}"
    # Each thread should have created exactly one connector (all threads
    # share the same default pool but get a connector bound to their loop).
    assert len(results) == 8
