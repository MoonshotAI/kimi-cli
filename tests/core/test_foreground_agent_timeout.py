from __future__ import annotations

import asyncio

from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent as SoulAgent
from kimi_cli.subagents.models import AgentTypeDefinition, ToolPolicy
from kimi_cli.tools.agent import (
    _DEFAULT_FOREGROUND_TIMEOUT_S,
    _resolve_foreground_timeout,
)


class TestResolveForegroundTimeout:
    def test_returns_explicit_timeout_when_set(self):
        assert _resolve_foreground_timeout(120) == 120

    def test_returns_default_when_none_and_no_env(self, monkeypatch):
        monkeypatch.delenv("KIMI_FOREGROUND_AGENT_TIMEOUT", raising=False)
        assert _resolve_foreground_timeout(None) == _DEFAULT_FOREGROUND_TIMEOUT_S

    def test_returns_env_value_when_set(self, monkeypatch):
        monkeypatch.setenv("KIMI_FOREGROUND_AGENT_TIMEOUT", "600")
        assert _resolve_foreground_timeout(None) == 600

    def test_returns_none_when_env_is_zero(self, monkeypatch):
        monkeypatch.setenv("KIMI_FOREGROUND_AGENT_TIMEOUT", "0")
        assert _resolve_foreground_timeout(None) is None

    def test_ignores_invalid_env_and_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("KIMI_FOREGROUND_AGENT_TIMEOUT", "not-a-number")
        assert _resolve_foreground_timeout(None) == _DEFAULT_FOREGROUND_TIMEOUT_S

    def test_explicit_timeout_overrides_env(self, monkeypatch):
        monkeypatch.setenv("KIMI_FOREGROUND_AGENT_TIMEOUT", "600")
        assert _resolve_foreground_timeout(120) == 120


async def test_foreground_agent_default_timeout_kills_hanging_subagent(
    agent_tool, runtime, monkeypatch
):
    """When no explicit timeout is given, the default foreground timeout
    (300s) should still kill a hanging subagent."""
    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="coder",
            description="Good at general software engineering tasks.",
            agent_file=runtime.subagent_store.root / "coder.yaml",
            tool_policy=ToolPolicy(mode="inherit"),
        )
    )

    async def fake_load_agent(agent_file, runtime, *, mcp_configs, start_mcp_loading=True):
        return SoulAgent(
            name=agent_file.stem,
            system_prompt="Subagent system prompt",
            toolset=EmptyToolset(),
            runtime=runtime,
        )

    async def fake_run_soul_hang(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        await asyncio.Event().wait()

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul_hang)

    # Patch the default to 1s so the test doesn't wait 5min
    monkeypatch.setattr("kimi_cli.tools.agent._DEFAULT_FOREGROUND_TIMEOUT_S", 1, raising=False)

    params = agent_tool.params(
        description="slow task with default timeout",
        prompt="do something slow",
        # No explicit timeout — should fall back to the patched default
    )

    result = await agent_tool(params)

    assert result.is_error
    assert "timed out" in result.message.lower()
