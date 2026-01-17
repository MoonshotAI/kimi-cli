from __future__ import annotations

from inline_snapshot import snapshot

from gitrekt_cli.tools.multiagent.create import CreateSubagent, Params


async def test_create_subagent(create_subagent_tool: CreateSubagent):
    """Test creating a subagent."""
    result = await create_subagent_tool(
        Params(
            name="test_agent",
            system_prompt="You are a test agent.",
        )
    )
    assert not result.is_error
    assert result.output == snapshot("Available subagents: mocker, test_agent")
    assert result.message == snapshot("Subagent 'test_agent' created successfully.")
    assert "test_agent" in create_subagent_tool._runtime.labor_market.subagents


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
    assert result.is_error
    assert result.message == snapshot("Subagent with name 'existing_agent' already exists.")
    assert result.brief == snapshot("Subagent already exists")
    assert "existing_agent" in create_subagent_tool._runtime.labor_market.subagents
