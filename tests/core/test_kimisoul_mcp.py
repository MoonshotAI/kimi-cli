from __future__ import annotations

from types import SimpleNamespace

import pytest

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.exception import MCPRuntimeError
from kimi_cli.soul.kimisoul import KimiSoul


class _FailingMCPToolset:
    def __init__(self) -> None:
        self.waited = False

    async def wait_for_mcp_tools(self) -> None:
        self.waited = True
        raise MCPRuntimeError("Failed to connect MCP servers: broken")


@pytest.mark.asyncio
async def test_background_mcp_loading_failure_does_not_stop_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    toolset = _FailingMCPToolset()
    soul = KimiSoul.__new__(KimiSoul)
    soul._agent = SimpleNamespace(toolset=toolset)
    monkeypatch.setattr(kimisoul_module, "KimiToolset", _FailingMCPToolset)

    await soul.wait_for_background_mcp_loading()

    assert toolset.waited
