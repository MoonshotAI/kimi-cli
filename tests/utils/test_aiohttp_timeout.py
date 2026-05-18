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
    async with new_client_session() as session:
        assert session.timeout.total == 120
        assert session.timeout.sock_read == 60
        assert session.timeout.sock_connect == 15


async def test_custom_timeout_override():
    import aiohttp

    custom = aiohttp.ClientTimeout(total=30, sock_read=10)
    async with new_client_session(timeout=custom) as session:
        assert session.timeout.total == 30
        assert session.timeout.sock_read == 10


async def test_slow_server_is_interrupted():
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
    async with new_client_session() as session1:
        connector1 = session1.connector

    async with new_client_session() as session2:
        connector2 = session2.connector

    assert connector1 is not None
    assert connector1 is connector2
    assert connector1.limit == 100
    assert connector1.limit_per_host == 30
    assert not connector1.closed


async def test_connector_recreated_after_close():
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
    seen_ports: set[int] = set()

    async def _handler(reader, writer):
        peer = writer.get_extra_info("peername")
        if peer is not None:
            seen_ports.add(peer[1])
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

        assert len(seen_ports) == 1, f"Expected connection reuse (1 port), got {seen_ports}"
    finally:
        server.close()
        await server.wait_closed()


async def test_stress_pool_under_load():
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
    pool = _ConnectionPool(limit=5, limit_per_host=2, register_atexit=False)

    async with pool.new_session() as s:
        assert s.connector is not None
        assert s.connector.limit == 5
        assert s.connector.limit_per_host == 2

    await pool.close()
    assert not pool._connectors


def test_separate_loops_get_separate_connectors():
    async def _get_connector_id():
        async with new_client_session() as s:
            return id(s.connector)

    id1 = asyncio.run(_get_connector_id())
    id2 = asyncio.run(_get_connector_id())

    assert id1 != id2, "Expected separate connectors for separate event loops"


def test_reaps_closed_loop_connectors():
    async def _get_connector():
        from kimi_cli.utils.aiohttp import _default_pool

        return _default_pool.get_connector()

    c1 = asyncio.run(_get_connector())
    c1_id = id(c1)

    c2 = asyncio.run(_get_connector())
    c2_id = id(c2)

    assert c1_id != c2_id, "Expected a new connector for the new loop"
    from kimi_cli.utils.aiohttp import _default_pool

    assert c1_id not in {id(c) for _, c in _default_pool._connectors.values()}


async def _get_connector_in_thread() -> int:
    async with new_client_session() as s:
        return id(s.connector)


def test_multi_threaded_access():
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
    assert len(results) == 8
    # Connectors are keyed by id(loop); sequential threads may reuse the
    # same memory address for a new loop after the old one is GC'd, so we
    # only assert that every thread succeeded, not that all IDs are unique.
