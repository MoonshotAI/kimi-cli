"""Tests for KimiToolset hide/unhide functionality."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any, cast

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from kosong.tooling.error import ToolNotFoundError as KosongToolNotFoundError
from mcp.types import Tool as MCPRawTool
from pydantic import BaseModel

from kimi_cli.soul.toolset import KimiToolset, MCPTool, _tool_schema_bytes
from kimi_cli.wire.types import ToolCall, ToolResult


class DummyParams(BaseModel):
    value: str = ""


class DummyToolA(CallableTool2[DummyParams]):
    name: str = "ToolA"
    description: str = "Tool A"
    params: type[DummyParams] = DummyParams

    async def __call__(self, params: DummyParams) -> ToolReturnValue:
        return ToolOk(output="a")


class DummyToolB(CallableTool2[DummyParams]):
    name: str = "ToolB"
    description: str = "Tool B"
    params: type[DummyParams] = DummyParams

    async def __call__(self, params: DummyParams) -> ToolReturnValue:
        return ToolOk(output="b")


def _make_toolset() -> KimiToolset:
    ts = KimiToolset()
    ts.add(DummyToolA())
    ts.add(DummyToolB())
    return ts


def _tool_names(ts: KimiToolset) -> set[str]:
    return {t.name for t in ts.tools}


# --- hide() ---


def test_hide_removes_from_tools_property():
    ts = _make_toolset()
    assert _tool_names(ts) == {"ToolA", "ToolB"}

    ts.hide("ToolA")
    assert _tool_names(ts) == {"ToolB"}


def test_hide_returns_true_for_existing_tool():
    ts = _make_toolset()
    assert ts.hide("ToolA") is True


def test_hide_returns_false_for_nonexistent_tool():
    ts = _make_toolset()
    assert ts.hide("NoSuchTool") is False


def test_hide_is_idempotent():
    ts = _make_toolset()
    ts.hide("ToolA")
    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    # Single unhide restores after multiple hides
    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)


def test_hide_multiple_tools():
    ts = _make_toolset()
    ts.hide("ToolA")
    ts.hide("ToolB")
    assert ts.tools == []


# --- unhide() ---


def test_unhide_restores_tool():
    ts = _make_toolset()
    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)


def test_unhide_nonexistent_is_noop():
    ts = _make_toolset()
    ts.unhide("NoSuchTool")
    assert _tool_names(ts) == {"ToolA", "ToolB"}


def test_unhide_without_prior_hide_is_noop():
    ts = _make_toolset()
    ts.unhide("ToolA")
    assert _tool_names(ts) == {"ToolA", "ToolB"}


# --- find() is unaffected ---


def test_hidden_tool_still_findable_by_name():
    ts = _make_toolset()
    ts.hide("ToolA")
    assert ts.find("ToolA") is not None


def test_hidden_tool_still_findable_by_type():
    ts = _make_toolset()
    ts.hide("ToolA")
    assert ts.find(DummyToolA) is not None


# --- handle() is unaffected ---


async def test_hidden_tool_still_handled():
    """handle() should dispatch to hidden tools instead of returning ToolNotFoundError."""
    ts = _make_toolset()
    ts.hide("ToolA")

    tool_call = ToolCall(
        id="tc-1",
        function=ToolCall.FunctionBody(
            name="ToolA",
            arguments=json.dumps({"value": "test"}),
        ),
    )
    result = ts.handle(tool_call)
    # For async tools, handle() returns an asyncio.Task.
    # A ToolNotFoundError would be returned as a sync ToolResult directly.
    if isinstance(result, ToolResult):
        assert not isinstance(result.return_value, KosongToolNotFoundError)
    else:
        assert isinstance(result, asyncio.Task)
        result.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await result


async def test_nonexistent_tool_returns_not_found():
    """handle() should return ToolNotFoundError for tools not in _tool_dict at all."""
    ts = _make_toolset()

    tool_call = ToolCall(
        id="tc-2",
        function=ToolCall.FunctionBody(
            name="NoSuchTool",
            arguments="{}",
        ),
    )
    result = ts.handle(tool_call)
    assert isinstance(result, ToolResult)
    assert isinstance(result.return_value, KosongToolNotFoundError)


# --- hide/unhide cycle ---


def test_hide_unhide_cycle():
    """Multiple hide/unhide cycles should work correctly."""
    ts = _make_toolset()

    ts.hide("ToolA")
    assert "ToolA" not in _tool_names(ts)

    ts.unhide("ToolA")
    assert "ToolA" in _tool_names(ts)


class _FakeMCPClient:
    def __init__(self, tools: list[MCPRawTool]):
        self._tools = tools

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def list_tools(self):
        return list(self._tools)

    async def close(self):
        return None


def _fake_mcp_config(server_name: str):
    from fastmcp.mcp_config import MCPConfig

    return MCPConfig.model_validate({"mcpServers": {server_name: {"command": "echo", "args": []}}})


async def test_mcp_tool_description_is_truncated_without_schema_changes(runtime):
    long_desc = "x" * 2000
    raw = MCPRawTool(
        name="LongTool",
        description=long_desc,
        inputSchema={"type": "object", "properties": {"value": {"type": "string"}}},
    )
    tool = MCPTool(
        "server-a",
        raw,
        cast(Any, _FakeMCPClient([raw])),
        runtime=runtime,
        exposed_name="mcp__server_a__LongTool",
        max_description_chars=100,
    )

    assert "[description truncated]" in tool.base.description
    assert tool.base.parameters == raw.inputSchema


async def test_load_mcp_tools_hides_tools_when_schema_budget_exceeded(runtime, monkeypatch):
    server_name = "server-a"
    small = MCPRawTool(
        name="SmallTool",
        description="small",
        inputSchema={"type": "object", "properties": {"value": {"type": "string"}}},
    )
    large = MCPRawTool(
        name="LargeTool",
        description="large",
        inputSchema={
            "type": "object",
            "properties": {
                "payload": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 0,
                    "maxItems": 500,
                }
            },
        },
    )

    preview_small = MCPTool(
        server_name,
        small,
        cast(Any, _FakeMCPClient([small])),
        runtime=runtime,
        exposed_name="mcp__server_a__SmallTool",
        max_description_chars=runtime.config.mcp.client.max_tool_description_chars,
    )
    small_bytes = _tool_schema_bytes(preview_small.base)

    runtime.config.mcp.client.max_visible_tools_per_server = 10
    runtime.config.mcp.client.max_total_tool_schema_bytes = small_bytes + 1

    def fake_client_factory(mcp_config):
        name = next(iter(mcp_config.mcpServers.keys()))
        assert name == server_name
        return _FakeMCPClient([small, large])

    monkeypatch.setattr("fastmcp.Client", fake_client_factory)

    ts = KimiToolset()
    await ts.load_mcp_tools([_fake_mcp_config(server_name)], runtime, in_background=False)

    assert [t.name for t in ts.mcp_servers[server_name].tools] == [
        "mcp__server-a__SmallTool",
        "mcp__server-a__LargeTool",
    ]
    assert {t.name for t in ts.tools} == {"mcp__server-a__SmallTool"}


async def test_load_mcp_tools_shows_budget_toast_for_hidden_tools(runtime, monkeypatch):
    server_name = "server-b"
    tools = [
        MCPRawTool(
            name=f"Tool{i}",
            description="small",
            inputSchema={"type": "object", "properties": {"value": {"type": "string"}}},
        )
        for i in range(3)
    ]
    runtime.config.mcp.client.max_visible_tools_per_server = 1
    runtime.config.mcp.client.max_total_tool_schema_bytes = 1_000_000

    def fake_client_factory(mcp_config):
        name = next(iter(mcp_config.mcpServers.keys()))
        assert name == server_name
        return _FakeMCPClient(tools)

    toasts: list[str] = []

    def fake_toast(message: str, *args, **kwargs):
        toasts.append(message)

    monkeypatch.setattr("fastmcp.Client", fake_client_factory)
    monkeypatch.setattr("kimi_cli.ui.shell.prompt.toast", fake_toast)

    ts = KimiToolset()
    await ts.load_mcp_tools([_fake_mcp_config(server_name)], runtime, in_background=True)
    await ts.wait_for_mcp_tools()

    assert {t.name for t in ts.tools} == {"mcp__server-b__Tool0"}
    assert any("hidden due to tool budget" in message for message in toasts)


async def test_load_mcp_tools_applies_global_schema_budget(runtime, monkeypatch):
    runtime.config.mcp.client.max_visible_tools_per_server = 10
    runtime.config.mcp.client.max_total_tool_schema_bytes = 1_000_000
    runtime.config.mcp.client.max_total_mcp_tool_schema_bytes = 500

    server_a = "server-a"
    server_b = "server-b"
    tools_a = [
        MCPRawTool(
            name=f"ToolA{i}",
            description="x" * 80,
            inputSchema={"type": "object", "properties": {"value": {"type": "string"}}},
        )
        for i in range(2)
    ]
    tools_b = [
        MCPRawTool(
            name=f"ToolB{i}",
            description="x" * 80,
            inputSchema={"type": "object", "properties": {"value": {"type": "string"}}},
        )
        for i in range(2)
    ]

    def fake_client_factory(mcp_config):
        name = next(iter(mcp_config.mcpServers.keys()))
        if name == server_a:
            return _FakeMCPClient(tools_a)
        if name == server_b:
            return _FakeMCPClient(tools_b)
        raise AssertionError(f"unexpected server name: {name}")

    monkeypatch.setattr("fastmcp.Client", fake_client_factory)

    ts = KimiToolset()
    await ts.load_mcp_tools(
        [_fake_mcp_config(server_a), _fake_mcp_config(server_b)],
        runtime,
        in_background=False,
    )
    visible = [t.name for t in ts.tools]
    assert len(visible) < 4
    assert len(visible) >= 1


async def test_load_mcp_tools_namespaced_tool_names_avoid_name_collisions(runtime, monkeypatch):
    tool_name = "search"
    server_a = "s1"
    server_b = "s2"
    runtime.config.mcp.client.max_visible_tools_per_server = 10
    runtime.config.mcp.client.max_total_tool_schema_bytes = 1_000_000
    runtime.config.mcp.client.max_total_mcp_tool_schema_bytes = 1_000_000

    def make_tool():
        return MCPRawTool(
            name=tool_name,
            description="desc",
            inputSchema={"type": "object", "properties": {"query": {"type": "string"}}},
        )

    def fake_client_factory(mcp_config):
        name = next(iter(mcp_config.mcpServers.keys()))
        if name == server_a:
            return _FakeMCPClient([make_tool()])
        if name == server_b:
            return _FakeMCPClient([make_tool()])
        raise AssertionError(f"unexpected server name: {name}")

    monkeypatch.setattr("fastmcp.Client", fake_client_factory)

    ts = KimiToolset()
    await ts.load_mcp_tools(
        [_fake_mcp_config(server_a), _fake_mcp_config(server_b)],
        runtime,
        in_background=False,
    )

    visible = {t.name for t in ts.tools}
    assert visible == {"mcp__s1__search", "mcp__s2__search"}
