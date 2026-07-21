from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
import kimi_cli.soul.slash as slash_module
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import FlowRunner, KimiSoul


@pytest.fixture(autouse=True)
def _patch_wire_send(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)
    monkeypatch.setattr(slash_module, "wire_send", lambda _msg: None)


@pytest.fixture(autouse=True)
def _patch_flow_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent the ralph loop from actually running in tests."""
    monkeypatch.setattr(FlowRunner, "run", AsyncMock(return_value=None))


@pytest.mark.asyncio
async def test_goal_slash_command_registered(runtime: Runtime, tmp_path: Path) -> None:
    """/goal should be available in soul-level slash commands."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    command_names = {cmd.name for cmd in soul.available_slash_commands}
    assert "goal" in command_names


@pytest.mark.asyncio
async def test_goal_create_persists_in_session_state(
    runtime: Runtime, tmp_path: Path
) -> None:
    """/goal <objective> should create and persist a GoalState."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal refactor the auth module")

    goal = runtime.session.state.goal
    assert goal is not None
    assert goal.objective == "refactor the auth module"
    assert goal.status == "active"
    assert goal.tokens_used == 0


@pytest.mark.asyncio
async def test_goal_show_status_when_no_goal(
    runtime: Runtime, tmp_path: Path
) -> None:
    """/goal with no args and no active goal should show a message."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    soul._turn = AsyncMock(return_value=None)  # type: ignore[method-assign]

    await soul.run("/goal")

    soul._turn.assert_not_awaited()


@pytest.mark.asyncio
async def test_goal_show_status_when_active(
    runtime: Runtime, tmp_path: Path
) -> None:
    """/goal with no args and an active goal should show status."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal write tests")
    await soul.run("/goal")

    goal = runtime.session.state.goal
    assert goal is not None
    assert goal.objective == "write tests"


@pytest.mark.asyncio
async def test_goal_pause_and_resume(
    runtime: Runtime, tmp_path: Path
) -> None:
    """/goal pause and /goal resume should toggle status."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal write tests")
    assert runtime.session.state.goal.status == "active"

    await soul.run("/goal pause")
    assert runtime.session.state.goal.status == "paused"

    await soul.run("/goal resume")
    assert runtime.session.state.goal.status == "active"


@pytest.mark.asyncio
async def test_goal_clear_removes_goal(
    runtime: Runtime, tmp_path: Path
) -> None:
    """/goal clear should remove the active goal."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal write tests")
    assert runtime.session.state.goal is not None

    await soul.run("/goal clear")
    assert runtime.session.state.goal is None


@pytest.mark.asyncio
async def test_goal_replace_previous_goal(
    runtime: Runtime, tmp_path: Path
) -> None:
    """Setting a new goal should replace the previous one."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal first goal")
    assert runtime.session.state.goal.objective == "first goal"

    await soul.run("/goal second goal")
    assert runtime.session.state.goal.objective == "second goal"


@pytest.mark.asyncio
async def test_goal_does_not_auto_generate_session_title(
    runtime: Runtime, tmp_path: Path
) -> None:
    """/goal should not trigger session title auto-generation."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal write tests")

    assert runtime.session.state.custom_title is None


@pytest.mark.asyncio
async def test_goal_token_tracking(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Goal tokens_used should be updated after a turn."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal write tests")
    assert runtime.session.state.goal.tokens_used == 0

    # Simulate token update
    soul._update_goal_tokens(150)
    assert runtime.session.state.goal.tokens_used == 150

    soul._update_goal_tokens(50)
    assert runtime.session.state.goal.tokens_used == 200


@pytest.mark.asyncio
async def test_goal_budget_limit(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Goal should transition to budget_limited when token budget is exceeded."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    await soul.run("/goal write tests")
    runtime.session.state.goal.token_budget = 100
    runtime.session.save_state()

    soul._update_goal_tokens(150)
    assert runtime.session.state.goal.status == "budget_limited"
