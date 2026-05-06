"""Tests for wire protocol plan mode support."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.tools.plan import ExitPlanMode
from kimi_cli.tools.plan.enter import EnterPlanMode
from kimi_cli.wire.jsonrpc import (
    ClientCapabilities,
    JSONRPCEventMessage,
    JSONRPCInitializeMessage,
    JSONRPCSetAfkMessage,
    JSONRPCSuccessResponse,
)
from kimi_cli.wire.types import StatusUpdate


class TestClientCapabilities:
    def test_defaults_to_false(self) -> None:
        caps = ClientCapabilities()
        assert caps.supports_plan_mode is False

    def test_parses_true(self) -> None:
        caps = ClientCapabilities(supports_plan_mode=True)
        assert caps.supports_plan_mode is True


class TestSyncPlanModeToolVisibility:
    def _make_toolset_with_plan_tools(self) -> KimiToolset:
        ts = KimiToolset()
        ts.add(ExitPlanMode())
        ts.add(EnterPlanMode())
        return ts

    def _make_server(self, supports_plan_mode: bool):
        """Create a minimal WireServer-like object with _sync_plan_mode_tool_visibility."""
        from kimi_cli.wire.server import WireServer

        # We need to construct WireServer with minimal mocking
        soul = MagicMock()
        soul.agent = MagicMock()
        soul.agent.runtime = MagicMock()
        soul.agent.runtime.labor_market.builtin_types = {}

        server = WireServer.__new__(WireServer)
        server._soul = soul
        server._client_supports_plan_mode = supports_plan_mode
        return server

    def test_hides_tools_when_unsupported(self) -> None:
        ts = self._make_toolset_with_plan_tools()
        server = self._make_server(supports_plan_mode=False)

        server._sync_plan_mode_tool_visibility(ts)

        # Tools should be hidden
        tool_names = {t.name for t in ts.tools}
        assert "ExitPlanMode" not in tool_names
        assert "EnterPlanMode" not in tool_names

    def test_tools_visible_when_supported(self) -> None:
        ts = self._make_toolset_with_plan_tools()
        server = self._make_server(supports_plan_mode=True)

        server._sync_plan_mode_tool_visibility(ts)

        tool_names = {t.name for t in ts.tools}
        assert "ExitPlanMode" in tool_names
        assert "EnterPlanMode" in tool_names

    def test_unhide_after_hide(self) -> None:
        ts = self._make_toolset_with_plan_tools()
        server = self._make_server(supports_plan_mode=False)

        # First hide
        server._sync_plan_mode_tool_visibility(ts)
        assert "ExitPlanMode" not in {t.name for t in ts.tools}

        # Then unhide
        server._client_supports_plan_mode = True
        server._sync_plan_mode_tool_visibility(ts)
        assert "ExitPlanMode" in {t.name for t in ts.tools}
        assert "EnterPlanMode" in {t.name for t in ts.tools}


@pytest.mark.asyncio
async def test_initialize_applies_runtime_instructions_to_system_prompt(
    runtime: Runtime, tmp_path: Path
) -> None:
    from kimi_cli.wire.server import WireServer

    context_path = tmp_path / "history.jsonl"
    context = Context(file_backend=context_path)
    await context.write_system_prompt("Base system prompt.")
    soul = KimiSoul(
        Agent(
            name="Wire Runtime Test",
            system_prompt="Base system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=context,
    )
    server = WireServer(soul)

    response = await server._handle_initialize(
        JSONRPCInitializeMessage(
            id="1",
            params=JSONRPCInitializeMessage.Params(
                protocol_version="1.9",
                runtime_instructions="Runtime rule: answer with ORDL framing.",
            ),
        )
    )

    assert isinstance(response, JSONRPCSuccessResponse)
    assert soul.agent.system_prompt.startswith("[Wire runtime instructions - highest priority]")
    assert "Runtime rule: answer with ORDL framing." in soul.agent.system_prompt
    assert "Base system prompt." in soul.agent.system_prompt

    restored = Context(file_backend=context_path)
    await restored.restore()
    assert restored.system_prompt == soul.agent.system_prompt


@pytest.mark.asyncio
async def test_set_afk_is_idempotent_wire_control(runtime: Runtime, tmp_path: Path) -> None:
    from kimi_cli.wire.server import WireServer

    context = Context(file_backend=tmp_path / "history.jsonl")
    await context.write_system_prompt("Base system prompt.")
    soul = KimiSoul(
        Agent(
            name="Wire AFK Test",
            system_prompt="Base system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=context,
    )
    server = WireServer(soul)

    response = await server._handle_set_afk(
        JSONRPCSetAfkMessage.model_validate(
            {
                "id": "afk-on",
                "method": "set_afk",
                "params": {"enabled": True},
            }
        )
    )
    event = await server._write_queue.get()

    assert isinstance(response, JSONRPCSuccessResponse)
    assert response.result == {"status": "ok", "afk_enabled": True}
    assert soul.runtime.approval.is_afk() is True
    assert isinstance(event, JSONRPCEventMessage)
    assert isinstance(event.params, StatusUpdate)
    assert event.params.afk_enabled is True

    response = await server._handle_set_afk(
        JSONRPCSetAfkMessage.model_validate(
            {
                "id": "afk-on-again",
                "method": "set_afk",
                "params": {"enabled": True},
            }
        )
    )

    assert isinstance(response, JSONRPCSuccessResponse)
    assert response.result == {"status": "ok", "afk_enabled": True}
    assert soul.runtime.approval.is_afk() is True
