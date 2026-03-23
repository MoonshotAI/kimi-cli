from __future__ import annotations

import platform

import pytest

from kimi_cli.agentspec import DEFAULT_AGENT_FILE
from kimi_cli.soul.agent import load_agent


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_default_root_agent_only_exposes_agent_tool_for_subagents(runtime):
    agent = await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    tool_names = [tool.name for tool in agent.toolset.tools]
    assert "Agent" in tool_names
    for legacy_name in ("Task", "CreateSubagent"):
        assert legacy_name not in tool_names
