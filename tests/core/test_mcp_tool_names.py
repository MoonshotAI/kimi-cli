from types import SimpleNamespace
from typing import Any, cast

import pytest
from mcp.types import Tool

from kimi_cli.soul.toolset import KimiToolset, MCPTool, _safe_mcp_tool_name


def test_safe_mcp_tool_name_preserves_compatible_name() -> None:
    assert _safe_mcp_tool_name("magic", "component_builder") == "component_builder"


def test_safe_mcp_tool_name_rewrites_invalid_name_stably() -> None:
    first = _safe_mcp_tool_name("magic", "21st.magic component builder")
    second = _safe_mcp_tool_name("magic", "21st.magic component builder")

    assert first == second
    assert first.startswith("m_21st_magic_component_builder_")
    assert len(first) <= 64


def test_mcp_tool_keeps_original_name_for_server_routing() -> None:
    upstream = Tool(
        name="21st_magic_component_builder",
        description="Build a component.",
        inputSchema={"type": "object", "properties": {}},
    )
    runtime = SimpleNamespace(
        config=SimpleNamespace(
            mcp=SimpleNamespace(client=SimpleNamespace(tool_call_timeout_ms=60_000))
        )
    )

    tool = MCPTool("magic", upstream, cast(Any, object()), runtime=cast(Any, runtime))

    assert tool.name.startswith("m_21st_magic_component_builder_")
    assert tool._mcp_tool.name == "21st_magic_component_builder"


def test_mcp_alias_collision_is_rejected_instead_of_silent_overwrite() -> None:
    server_name = "magic"
    invalid_name = "21st.magic component builder"
    generated_alias = _safe_mcp_tool_name(server_name, invalid_name)
    runtime = SimpleNamespace(
        config=SimpleNamespace(
            mcp=SimpleNamespace(client=SimpleNamespace(tool_call_timeout_ms=60_000))
        )
    )
    client = cast(Any, object())
    invalid_tool = MCPTool(
        server_name,
        Tool(name=invalid_name, description="invalid original", inputSchema={"type": "object"}),
        client,
        runtime=cast(Any, runtime),
    )
    valid_tool = MCPTool(
        server_name,
        Tool(
            name=generated_alias,
            description="valid original",
            inputSchema={"type": "object"},
        ),
        client,
        runtime=cast(Any, runtime),
    )

    assert invalid_tool.name == valid_tool.name

    toolset = KimiToolset()
    toolset.add(invalid_tool)

    with pytest.raises(ValueError, match="MCP tool name conflict"):
        toolset.add(valid_tool)

    assert toolset.find(generated_alias) is invalid_tool
