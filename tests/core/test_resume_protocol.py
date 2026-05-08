from __future__ import annotations

import re


def _extract_line(output: str, key: str) -> str | None:
    match = re.search(rf"^{re.escape(key)}: (.+)$", output, re.MULTILINE)
    return match.group(1) if match is not None else None


async def test_resume_protocol_surfaces_actual_subagent_type(agent_tool, runtime, monkeypatch):
    from kosong.message import Message
    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.soul.agent import Agent as SoulAgent
    from kimi_cli.subagents import AgentLaunchSpec, AgentTypeDefinition, ToolPolicy
    from kimi_cli.wire.types import TextPart

    runtime.labor_market.add_builtin_type(
        AgentTypeDefinition(
            name="mocker",
            description="The mock agent for testing purposes.",
            agent_file=runtime.subagent_store.root / "mocker.yaml",
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

    async def fake_run_soul(
        soul, user_input, ui_loop_fn, cancel_event, wire_file=None, runtime=None
    ):
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="done")])
        )

    monkeypatch.setattr("kimi_cli.subagents.builder.load_agent", fake_load_agent)
    monkeypatch.setattr("kimi_cli.subagents.runner.run_soul", fake_run_soul)

    runtime.subagent_store.create_instance(
        agent_id="aexisting",
        description="old instance",
        launch_spec=AgentLaunchSpec(
            agent_id="aexisting",
            subagent_type="mocker",
            model_override=None,
            effective_model=None,
        ),
    )

    result = await agent_tool(
        agent_tool.params(
            description="resume work",
            prompt="continue the previous work",
            subagent_type="coder",
            resume="aexisting",
        )
    )

    assert not result.is_error
    assert _extract_line(result.output, "status") == "completed"
    assert _extract_line(result.output, "resumed") == "true"
    assert _extract_line(result.output, "requested_subagent_type") == "coder"
    assert _extract_line(result.output, "actual_subagent_type") == "mocker"
