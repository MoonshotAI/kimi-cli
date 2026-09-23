"""Unit tests for ACPServer.initialize — argv handling."""

from __future__ import annotations

import pytest

from kimi_cli.acp.server import ACPServer

pytestmark = pytest.mark.asyncio


async def test_initialize_advertises_terminal_auth_method():
    """initialize() should advertise terminal auth using the ACP schema."""
    server = ACPServer()

    resp = await server.initialize(protocol_version=1)

    assert resp.protocol_version == 1
    assert resp.auth_methods is not None
    assert len(resp.auth_methods) == 1

    auth_method = resp.auth_methods[0]
    assert auth_method.type == "terminal"
    assert auth_method.args == ["login"]
    assert auth_method.env == {}
