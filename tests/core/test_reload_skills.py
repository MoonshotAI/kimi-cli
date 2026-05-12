"""Tests for the /reload-skills functionality."""

from __future__ import annotations

from pathlib import Path

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime, load_system_prompt
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul


def _write_skill(skill_dir: Path, name: str, description: str) -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nTest skill content.",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_runtime_reload_skills_discovers_new_skill(runtime: Runtime, tmp_path: Path) -> None:
    """Runtime.reload_skills() should pick up skills added after session start."""
    # Place the new skill inside the session's work_dir under .agents/skills/
    # so resolve_skills_roots discovers it via find_project_skills_dirs.
    project_skills_dir = runtime.session.work_dir.unsafe_to_local_path() / ".agents" / "skills"
    _write_skill(project_skills_dir / "dynamic-skill", "dynamic-skill", "A dynamic skill")

    runtime.skills = {}

    reloaded = await runtime.reload_skills()

    reloaded_names = {s.name for s in reloaded}
    assert "dynamic-skill" in reloaded_names
    assert "dynamic-skill" in runtime.skills
    assert "dynamic-skill" in runtime.builtin_args.KIMI_SKILLS


@pytest.mark.asyncio
async def test_kimisoul_refresh_slash_commands_includes_new_skill(
    runtime: Runtime, tmp_path: Path
) -> None:
    """KimiSoul.refresh_slash_commands() should rebuild /skill:xxx commands for new skills."""
    runtime.skills = {}

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

    initial_names = {cmd.name for cmd in soul.available_slash_commands}
    assert "skill:new-skill" not in initial_names

    # Add a skill directory *after* the soul is created inside work_dir
    project_skills_dir = runtime.session.work_dir.unsafe_to_local_path() / ".agents" / "skills"
    _write_skill(project_skills_dir / "new-skill", "new-skill", "A late-registered skill")

    await soul.refresh_slash_commands()

    new_names = {cmd.name for cmd in soul.available_slash_commands}
    assert "skill:new-skill" in new_names


@pytest.mark.asyncio
async def test_reload_skills_updates_builtin_args(runtime: Runtime, tmp_path: Path) -> None:
    """Reloading skills should update the KIMI_SKILLS builtin argument."""
    project_skills_dir = runtime.session.work_dir.unsafe_to_local_path() / ".agents" / "skills"
    _write_skill(project_skills_dir / "alpha", "alpha", "Alpha skill")
    _write_skill(project_skills_dir / "beta", "beta", "Beta skill")

    runtime.skills = {}
    runtime.builtin_args = runtime.builtin_args  # ensure it's set

    original_skills_text = runtime.builtin_args.KIMI_SKILLS

    await runtime.reload_skills()

    new_skills_text = runtime.builtin_args.KIMI_SKILLS
    assert "alpha" in new_skills_text
    assert "beta" in new_skills_text
    assert new_skills_text != original_skills_text or "No skills found." not in new_skills_text


@pytest.mark.asyncio
async def test_reload_skills_renders_system_prompt_for_compaction(
    runtime: Runtime, tmp_path: Path
) -> None:
    """After reload, KimiSoul._system_prompt must be re-rendered so that compaction
    writes the updated skill list instead of the stale one.

    This guards against the bug where Agent.system_prompt (frozen at load time)
    is written back by compact_context(), losing awareness of reloaded skills.
    """
    # Create a Jinja2 template that embeds ${KIMI_SKILLS}
    template_path = tmp_path / "system_prompt.j2"
    template_path.write_text(
        "You are a test agent.\n\nSkills:\n${KIMI_SKILLS}", encoding="utf-8"
    )

    runtime.skills = {}
    original_prompt = load_system_prompt(template_path, {}, runtime.builtin_args)
    assert "No skills found." in original_prompt

    agent = Agent(
        name="Test Agent",
        system_prompt=original_prompt,
        toolset=EmptyToolset(),
        runtime=runtime,
        system_prompt_path=template_path,
        system_prompt_args={},
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    assert soul._system_prompt == original_prompt

    # Add a skill after the soul is created
    project_skills_dir = runtime.session.work_dir.unsafe_to_local_path() / ".agents" / "skills"
    _write_skill(project_skills_dir / "late-skill", "late-skill", "A late skill")

    # Reload skills
    await soul.refresh_slash_commands()

    # The mutable _system_prompt should now contain the new skill
    assert "late-skill" in soul._system_prompt, (
        "_system_prompt was not re-rendered after reload"
    )

    # Verify the mutable _system_prompt carries the update (this is what
    # compact_context writes back to context, so if it is stale the bug exists).
    assert "late-skill" in soul._system_prompt, (
        "Simulated compaction would revert to stale system prompt"
    )
