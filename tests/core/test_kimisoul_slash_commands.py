from __future__ import annotations

from pathlib import Path
from typing import Any

from kaos.path import KaosPath
from kosong.tooling.empty import EmptyToolset

from kimi_cli.claude_plugin.spec import (
    ClaudePluginBundle,
    ClaudePluginManifest,
    ClaudePluginRuntime,
)
from kimi_cli.skill import Skill
from kimi_cli.skill.flow import Flow, FlowEdge, FlowNode
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import TextPart


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


def test_plugin_flow_skill_warning_uses_registered_command_name(runtime: Runtime, tmp_path: Path) -> None:
    """When plugin flow skills are invoked with args, FlowRunner should log the
    actual registered slash command (/plug:flowy), not /flow:plug:flowy."""
    import asyncio

    flow = _make_flow()
    skill_dir = tmp_path / "plug-flow-warning"
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
    cmd = next(c for c in soul.available_slash_commands if c.name == "plug:flowy")

    import kimi_cli.soul.kimisoul as _mod

    captured: list[tuple[str, str]] = []
    original_warning = _mod.logger.warning

    def _capture_warning(message: str, *args: object, **kwargs: object) -> None:
        command = str(kwargs.get("command", ""))
        captured.append((message, command))

    _mod.logger.warning = _capture_warning  # type: ignore[assignment]
    try:
        ret = cmd.func(soul, "extra args")
        assert ret is not None

        async def _await_runner(awaitable: Any) -> None:
            await awaitable

        asyncio.run(_await_runner(ret))
    finally:
        _mod.logger.warning = original_warning  # type: ignore[assignment]

    assert len(captured) == 1
    assert captured[0][1] == "/plug:flowy"


def test_bare_plugin_flow_dispatch_uses_registered_command_name(runtime: Runtime, tmp_path: Path) -> None:
    """Bare plugin flow dispatch should construct FlowRunner with the same
    registered command name used by slash-command registration."""
    import asyncio

    import kimi_cli.soul.kimisoul as _mod

    flow = _make_flow()
    skill_dir = tmp_path / "bare-plug-flow"
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
    bundle = ClaudePluginBundle(
        plugins={
            "plug": ClaudePluginRuntime(
                manifest=ClaudePluginManifest(name="plug", version="1.0.0"),
                root=tmp_path,
            )
        }
    )
    soul.register_plugin_commands(bundle)

    captured: dict[str, object] = {}
    original_flow_runner = _mod.FlowRunner

    class _FakeFlowRunner:
        def __init__(self, flow, *, name, display_command=None):
            captured["name"] = name
            captured["display_command"] = display_command

        async def run(self, soul_obj, args: str) -> None:
            captured["args"] = args

    _mod.FlowRunner = _FakeFlowRunner  # type: ignore[assignment]
    try:
        result = asyncio.run(soul._dispatch_bare_plugin_invocation("plug:flowy"))
    finally:
        _mod.FlowRunner = original_flow_runner  # type: ignore[assignment]

    assert result is True
    assert captured["name"] == "plug:flowy"
    assert captured["display_command"] == "/plug:flowy"
    assert captured["args"] == ""


def test_plugin_skill_error_text_uses_namespaced_name(runtime: Runtime, tmp_path: Path) -> None:
    """When a plugin skill fails to load, the error message must show
    the real slash command /myplugin:greet, not /skill:myplugin:greet."""
    import asyncio

    from kimi_cli.soul.kimisoul import KimiSoul

    skill_dir = tmp_path / "broken-skill"
    skill_dir.mkdir()
    # Don't create SKILL.md — read_skill_text will return None
    plugin_skill = Skill(
        name="myplugin:greet",
        description="Greet",
        type="standard",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
        is_plugin=True,
    )
    runtime.skills = {"myplugin:greet": plugin_skill}

    agent = Agent(
        name="Test",
        system_prompt="Test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "ctx.jsonl"))
    runner = soul._make_skill_runner(plugin_skill)

    # Capture what wire_send receives
    sent_parts: list[str] = []
    import kimi_cli.soul.kimisoul as _mod

    original_wire_send = _mod.wire_send

    def _capture(part: object) -> None:
        if isinstance(part, TextPart):
            sent_parts.append(part.text)

    _mod.wire_send = _capture  # type: ignore[assignment]
    try:
        ret = runner(soul, "")
        assert ret is not None

        async def _await_runner(awaitable: Any) -> None:
            await awaitable

        asyncio.run(_await_runner(ret))
    finally:
        _mod.wire_send = original_wire_send

    assert len(sent_parts) == 1
    assert "/myplugin:greet" in sent_parts[0]
    assert "/skill:myplugin:greet" not in sent_parts[0]


def test_native_skill_error_text_uses_skill_prefix(runtime: Runtime, tmp_path: Path) -> None:
    """Native skills should still show /skill:name in error text."""
    import asyncio

    from kimi_cli.soul.kimisoul import KimiSoul

    skill_dir = tmp_path / "broken-native"
    skill_dir.mkdir()
    native_skill = Skill(
        name="my-helper",
        description="Helper",
        type="standard",
        dir=KaosPath.unsafe_from_local_path(skill_dir),
    )
    runtime.skills = {"my-helper": native_skill}

    agent = Agent(
        name="Test",
        system_prompt="Test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "ctx.jsonl"))
    runner = soul._make_skill_runner(native_skill)

    sent_parts: list[str] = []
    import kimi_cli.soul.kimisoul as _mod

    original_wire_send = _mod.wire_send

    def _capture(part: object) -> None:
        if isinstance(part, TextPart):
            sent_parts.append(part.text)

    _mod.wire_send = _capture  # type: ignore[assignment]
    try:
        ret = runner(soul, "")
        assert ret is not None

        async def _await_runner(awaitable: Any) -> None:
            await awaitable

        asyncio.run(_await_runner(ret))
    finally:
        _mod.wire_send = original_wire_send

    assert len(sent_parts) == 1
    assert "/skill:my-helper" in sent_parts[0]
