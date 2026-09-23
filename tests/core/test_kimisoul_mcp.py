from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast

import pytest

from kimi_cli.exception import MCPRuntimeError
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset


async def test_background_mcp_failure_does_not_abort_the_turn() -> None:
    """A failed optional MCP server must not make the whole CLI unusable."""
    toolset = KimiToolset()

    async def fail_to_connect() -> None:
        raise MCPRuntimeError("Failed to connect MCP servers: {'slow': timeout}")

    toolset._mcp_loading_task = asyncio.create_task(fail_to_connect())
    soul = KimiSoul.__new__(KimiSoul)
    cast(Any, soul)._agent = SimpleNamespace(toolset=toolset)

    await soul.wait_for_background_mcp_loading()

    assert toolset._mcp_loading_task is None


async def test_background_mcp_wait_does_not_hide_unexpected_errors() -> None:
    toolset = KimiToolset()

    async def fail_unexpectedly() -> None:
        raise ValueError("broken loader invariant")

    toolset._mcp_loading_task = asyncio.create_task(fail_unexpectedly())
    soul = KimiSoul.__new__(KimiSoul)
    cast(Any, soul)._agent = SimpleNamespace(toolset=toolset)

    with pytest.raises(ValueError, match="broken loader invariant"):
        await soul.wait_for_background_mcp_loading()

    assert toolset._mcp_loading_task is None
