"""Tests for aiohttp client session timeout configuration."""

from __future__ import annotations

import asyncio

import pytest

from kimi_cli.utils.aiohttp import new_client_session


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
