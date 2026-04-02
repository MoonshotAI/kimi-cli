from __future__ import annotations

from pathlib import Path

from kaos.path import KaosPath
from kosong.tooling.empty import EmptyToolset

from kimi_cli.skill import Skill
from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul


def _make_flow() -> Flow:
    nodes = {
        "BEGIN": FlowNode(id="BEGIN", label="Begin", kind="begin"),
        "END": FlowNode(id="END", label="End", kind="end"),
    }
    outgoing = {
        "BEGIN": [FlowEdge(src="BEGIN", dst="END", label=None)],
        "END": [],
    }
    return Flow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")


def test_flow_skill_registers_skill_and_flow_commands(runtime: Runtime, tmp_path: Path) -> None:
    flow = _make_flow()
    skill_dir = tmp_path / "flow-skill"
    skill_dir.mkdir()
    flow_skill = Skill(
        name="flow-skill",
        description="Flow skill",
        type="flow",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
        flow=flow,
    )
    runtime.skills = {"flow-skill": flow_skill}

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    command_names = {cmd.name for cmd in soul.available_slash_commands}
    assert "skill:flow-skill" in command_names
    assert "flow:flow-skill" in command_names


def test_plugin_skills_register_without_skill_prefix(runtime: Runtime, tmp_path: Path) -> None:
    """Plugin skills (is_plugin=True) should register directly,
    not with an extra 'skill:' prefix."""
    skill_dir = tmp_path / "plugin-skill"
    skill_dir.mkdir()
    plugin_skill = Skill(
        name="myplugin:greet",
        description="Greet",
        type="standard",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
        is_plugin=True,
    )
    native_skill = Skill(
        name="native-skill",
        description="Native",
        type="standard",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
    )
    runtime.skills = {
        "myplugin:greet": plugin_skill,
        "native-skill": native_skill,
    }

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    command_names = {cmd.name for cmd in soul.available_slash_commands}
    # Plugin skill: no "skill:" prefix
    assert "myplugin:greet" in command_names
    assert "skill:myplugin:greet" not in command_names
    # Native skill: keeps "skill:" prefix
    assert "skill:native-skill" in command_names


def test_native_skill_with_colon_keeps_skill_prefix(runtime: Runtime, tmp_path: Path) -> None:
    """A native skill whose name contains ':' but is NOT a plugin skill
    must keep the 'skill:' prefix — the colon alone must not change behavior."""
    skill_dir = tmp_path / "colon-skill"
    skill_dir.mkdir()
    native_colon_skill = Skill(
        name="foo:bar",
        description="Native colon skill",
        type="standard",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
        # is_plugin defaults to False
    )
    runtime.skills = {"foo:bar": native_colon_skill}

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    command_names = {cmd.name for cmd in soul.available_slash_commands}
    assert "skill:foo:bar" in command_names
    assert "foo:bar" not in command_names


def test_plugin_flow_skill_uses_flow_runner(runtime: Runtime, tmp_path: Path) -> None:
    """A plugin flow skill must be registered with FlowRunner, not the
    plain skill runner.  Regression test for the duplicate-name bug where
    the first loop grabbed the name and the FlowRunner was never attached."""
    flow = _make_flow()
    skill_dir = tmp_path / "plug-flow"
    skill_dir.mkdir()
    plugin_flow_skill = Skill(
        name="plug:flowy",
        description="Plugin flow",
        type="flow",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
        flow=flow,
        is_plugin=True,
    )
    runtime.skills = {"plug:flowy": plugin_flow_skill}

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    command_names = {cmd.name for cmd in soul.available_slash_commands}
    # Should be registered exactly once, under its namespaced name
    assert "plug:flowy" in command_names
    assert "skill:plug:flowy" not in command_names
    assert "flow:plug:flowy" not in command_names

    # The handler must be FlowRunner.run, not _make_skill_runner
    cmd = next(c for c in soul.available_slash_commands if c.name == "plug:flowy")
    # FlowRunner.run is a bound method on a FlowRunner instance
    assert "FlowRunner" in type(cmd.func.__self__).__name__
