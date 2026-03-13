"""Tests for KimiToolset hide/unhide functionality."""

from __future__ import annotations

import asyncio
import contextlib
import json

import fastmcp
from fastmcp.client.auth.oauth import FileTokenStorage
from fastmcp.mcp_config import MCPConfig, RemoteMCPServer
from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from kosong.tooling.error import ToolNotFoundError as KosongToolNotFoundError
from pydantic import BaseModel

from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.ui.shell import prompt as prompt_module
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
    def __init__(self, server_name: str, behaviors: dict[str, dict[str, object]]) -> None:
        self._server_name = server_name
        self._behaviors = behaviors

    async def __aenter__(self) -> _FakeMCPClient:
        enter_error = self._behaviors[self._server_name].get("enter_error")
        if isinstance(enter_error, Exception):
            raise enter_error
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def list_tools(self) -> list[object]:
        list_error = self._behaviors[self._server_name].get("list_error")
        if isinstance(list_error, Exception):
            raise list_error
        tools = self._behaviors[self._server_name].get("tools", [])
        return list(tools) if isinstance(tools, list) else []


def _install_mcp_test_doubles(
    monkeypatch,
    behaviors: dict[str, dict[str, object]],
    *,
    authorized_servers: set[str] | None = None,
) -> list[str]:
    messages: list[str] = []
    authorized_servers = authorized_servers or set()

    def fake_toast(
        message: str,
        duration: float = 5.0,
        topic: str | None = None,
        immediate: bool = False,
        position: str = "left",
    ) -> None:
        del duration, topic, immediate, position
        messages.append(message)

    def fake_client(config: MCPConfig) -> _FakeMCPClient:
        server_name = next(iter(config.mcpServers))
        return _FakeMCPClient(server_name, behaviors)

    async def fake_get_tokens(self) -> object | None:
        return object() if self.server_url.rsplit("/", 2)[-2] in authorized_servers else None

    monkeypatch.setattr(prompt_module, "toast", fake_toast)
    monkeypatch.setattr(fastmcp, "Client", fake_client)
    monkeypatch.setattr(FileTokenStorage, "get_tokens", fake_get_tokens)
    return messages


async def _load_mcp_tools_with_messages(
    monkeypatch,
    runtime,
    configs: list[MCPConfig],
    behaviors: dict[str, dict[str, object]],
    *,
    authorized_servers: set[str] | None = None,
) -> list[str]:
    messages = _install_mcp_test_doubles(
        monkeypatch,
        behaviors,
        authorized_servers=authorized_servers,
    )
    toolset = KimiToolset()
    await toolset.load_mcp_tools(configs, runtime, in_background=True)
    await toolset.wait_for_mcp_tools()
    return messages


def _remote_config(name: str, *, auth: str | None = None) -> MCPConfig:
    return MCPConfig(
        mcpServers={name: RemoteMCPServer(url=f"https://{name}.example.com/mcp", auth=auth)}
    )


async def test_load_mcp_tools_shows_failure_toast_without_success(monkeypatch, runtime):
    messages = await _load_mcp_tools_with_messages(
        monkeypatch,
        runtime,
        [_remote_config("ok"), _remote_config("broken")],
        {
            "ok": {"tools": []},
            "broken": {"list_error": RuntimeError("boom")},
        },
    )

    assert messages == [
        "connecting to mcp servers...",
        "mcp connection failed: broken",
    ]


async def test_load_mcp_tools_shows_authorization_toast_without_success(monkeypatch, runtime):
    messages = await _load_mcp_tools_with_messages(
        monkeypatch,
        runtime,
        [_remote_config("oauth-server", auth="oauth")],
        {
            "oauth-server": {"tools": []},
        },
    )

    assert messages == [
        "connecting to mcp servers...",
        "mcp authorization needed",
    ]


async def test_load_mcp_tools_shows_success_toast_when_all_connected(monkeypatch, runtime):
    messages = await _load_mcp_tools_with_messages(
        monkeypatch,
        runtime,
        [_remote_config("ok-a"), _remote_config("ok-b")],
        {
            "ok-a": {"tools": []},
            "ok-b": {"tools": []},
        },
        authorized_servers={"ok-a", "ok-b"},
    )

    assert messages == [
        "connecting to mcp servers...",
        "mcp servers connected",
    ]


async def test_load_mcp_tools_prioritizes_failure_over_unauthorized(monkeypatch, runtime):
    messages = await _load_mcp_tools_with_messages(
        monkeypatch,
        runtime,
        [
            _remote_config("broken"),
            _remote_config("oauth-server", auth="oauth"),
        ],
        {
            "broken": {"enter_error": RuntimeError("boom")},
            "oauth-server": {"tools": []},
        },
    )

    assert messages == [
        "connecting to mcp servers...",
        "mcp connection failed: broken",
    ]
