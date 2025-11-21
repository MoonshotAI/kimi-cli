from __future__ import annotations

import pytest
from inline_snapshot import snapshot
from kosong.tooling import ToolError, ToolOk

from kimi_cli.tools.multiagent.create import CreateSubagent, Params


@pytest.mark.asyncio
async def test_create_subagent(create_subagent_tool: CreateSubagent):
    """Test creating a subagent."""
    result = await create_subagent_tool(
        Params(
            name="test_agent",
            system_prompt="You are a test agent.",
        )
    )
    assert result == snapshot(
        ToolOk(
            output="Available subagents: mocker, test_agent",
            message="Subagent 'test_agent' created successfully.",
        )
    )
    assert "test_agent" in create_subagent_tool._runtime.labor_market.subagents


@pytest.mark.asyncio
async def test_create_existing_subagent(create_subagent_tool: CreateSubagent):
    """Test creating a subagent with an existing name."""
    # First, create the subagent
    await create_subagent_tool(
        Params(
            name="existing_agent",
            system_prompt="You are an existing agent.",
        )
    )
    assert "existing_agent" in create_subagent_tool._runtime.labor_market.subagents

    # Try to create the same subagent again
    result = await create_subagent_tool(
        Params(
            name="existing_agent",
            system_prompt="You are an existing agent.",
        )
    )
    assert result == snapshot(
        ToolError(
            message="Subagent with name 'existing_agent' already exists.",
            brief="Subagent already exists",
        )
    )
    assert "existing_agent" in create_subagent_tool._runtime.labor_market.subagents
