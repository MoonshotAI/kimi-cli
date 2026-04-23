"""Tests for rendering the skills block in the system prompt (scope-grouped).

These tests cover fix B (proj scope skills visibility bug):
before the fix, skills were listed as a flat bullet list without scope labels,
so the model could not tell user-scope from project-scope skills. After the fix,
they are grouped under ``Built-in`` / ``User`` / ``Project`` / ``Extra`` headings
(empty groups are omitted).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from kaos.path import KaosPath

from kimi_cli.skill import (
    Skill,
    format_skills_for_prompt,
)


def _skill(name: str, scope: str, description: str = "desc") -> Skill:
    skill_dir = KaosPath.unsafe_from_local_path(Path(f"/tmp/{scope}/{name}"))
    return Skill(
        name=name,
        description=description,
        type="standard",
        dir=skill_dir,
        skill_md_file=skill_dir / "SKILL.md",
        scope=scope,  # type: ignore[arg-type]
        flow=None,
    )


def test_skill_has_scope_field():
    """Each Skill carries a scope label set by discovery."""
    s = _skill("alpha", "user")
    assert s.scope == "user"


def test_format_skills_for_prompt_groups_by_scope():
    """Skills are rendered under scope headings in canonical order."""
    skills = [
        _skill("builtin-a", "builtin"),
        _skill("user-a", "user"),
        _skill("proj-a", "project"),
        _skill("extra-a", "extra"),
    ]

    rendered = format_skills_for_prompt(skills)

    # Section headings exist and appear in the canonical order
    assert "### Project" in rendered
    assert "### User" in rendered
    assert "### Extra" in rendered
    assert "### Built-in" in rendered

    proj_idx = rendered.index("### Project")
    user_idx = rendered.index("### User")
    extra_idx = rendered.index("### Extra")
    builtin_idx = rendered.index("### Built-in")

    # Project first (most specific), then User, then Extra, then Built-in
    assert proj_idx < user_idx < extra_idx < builtin_idx

    # Each skill appears under its own scope group, not the others
    def _section(header: str) -> str:
        start = rendered.index(header)
        # find next "### " after start (or end)
        next_ = rendered.find("### ", start + 1)
        return rendered[start : next_ if next_ != -1 else len(rendered)]

    assert "proj-a" in _section("### Project")
    assert "user-a" in _section("### User")
    assert "extra-a" in _section("### Extra")
    assert "builtin-a" in _section("### Built-in")

    assert "proj-a" not in _section("### User")
    assert "user-a" not in _section("### Project")


def test_format_skills_for_prompt_omits_empty_groups():
    """Groups with no skills are not rendered (no dangling header)."""
    skills = [_skill("alpha", "user")]

    rendered = format_skills_for_prompt(skills)

    assert "### User" in rendered
    assert "### Project" not in rendered
    assert "### Extra" not in rendered
    assert "### Built-in" not in rendered


def test_format_skills_for_prompt_empty_input_returns_placeholder():
    """Zero skills → a human-readable "no skills" marker, not empty string."""
    rendered = format_skills_for_prompt([])

    # Should be non-empty and clearly indicate no skills
    assert rendered.strip() != ""
    assert "No skills" in rendered or "no skills" in rendered.lower()


def test_format_skills_for_prompt_lists_name_path_description():
    """Each skill line carries name, path, description (preserves existing shape)."""
    skills = [_skill("alpha", "user", description="Alpha does things")]

    rendered = format_skills_for_prompt(skills)

    assert "alpha" in rendered
    assert "Alpha does things" in rendered
    # Path is included (helps model read the skill on demand)
    assert "/tmp/user/alpha" in rendered


def test_format_skills_for_prompt_sorts_within_scope():
    """Within a scope group, skills are sorted by name for stable output."""
    skills = [
        _skill("zebra", "user"),
        _skill("alpha", "user"),
        _skill("mango", "user"),
    ]

    rendered = format_skills_for_prompt(skills)

    a_idx = rendered.index("alpha")
    m_idx = rendered.index("mango")
    z_idx = rendered.index("zebra")
    assert a_idx < m_idx < z_idx


@pytest.mark.asyncio
async def test_discovered_skills_carry_scope(tmp_path, monkeypatch):
    """End-to-end: scoped discovery stamps each skill with its origin scope."""
    from kimi_cli.skill import (
        discover_skills_from_roots,
        resolve_skills_roots,
    )

    home_dir = tmp_path / "home"
    user_brand = home_dir / ".kimi" / "skills"
    user_brand.mkdir(parents=True)
    (user_brand / "user-skill").mkdir()
    (user_brand / "user-skill" / "SKILL.md").write_text(
        "---\nname: user-skill\ndescription: u\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    proj_brand = work_dir / ".kimi" / "skills"
    proj_brand.mkdir(parents=True)
    (proj_brand / "proj-skill").mkdir()
    (proj_brand / "proj-skill" / "SKILL.md").write_text(
        "---\nname: proj-skill\ndescription: p\n---\n",
        encoding="utf-8",
    )

    scoped = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(scoped)

    by_name = {s.name: s for s in skills}
    assert by_name["user-skill"].scope == "user"
    assert by_name["proj-skill"].scope == "project"


# ---------------------------------------------------------------------------
# End-to-end smoke test: user pain point locked in
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_end_to_end_project_override_renders_correctly(tmp_path, monkeypatch):
    """PR's terminal contract: a ``foo`` skill defined in 4 scopes (builtin,
    user, project, extra) renders once under ``### Project`` — the project
    version wins and the other three are not exposed to the model at all.

    This is the smoke test that proves the user-reported pain point
    ("kimi cli 居然不支持 proj scope skills") is fixed: when a project-local
    skill shares a name with skills at other scopes, the project version is
    the one injected into the system prompt, grouped under ``### Project``.
    """
    import kimi_cli.skill as skill_mod
    from kimi_cli.skill import (
        discover_skills_from_roots,
        resolve_skills_roots,
    )

    # 1. Built-in scope
    builtin_dir = tmp_path / "fake_builtin"
    builtin_dir.mkdir()
    (builtin_dir / "foo").mkdir()
    (builtin_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: builtin version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(skill_mod, "get_builtin_skills_dir", lambda: builtin_dir)

    # 2. User scope (via monkeypatched home dir)
    home_dir = tmp_path / "home"
    user_brand = home_dir / ".kimi" / "skills"
    user_brand.mkdir(parents=True)
    (user_brand / "foo").mkdir()
    (user_brand / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: user version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    # 3. Project scope
    work_dir = tmp_path / "project"
    proj_brand = work_dir / ".kimi" / "skills"
    proj_brand.mkdir(parents=True)
    (proj_brand / "foo").mkdir()
    proj_foo_md = proj_brand / "foo" / "SKILL.md"
    proj_foo_md.write_text(
        "---\nname: foo\ndescription: project version\n---\n",
        encoding="utf-8",
    )

    # 4. Extra scope (via extra_skill_dirs)
    extra_dir = tmp_path / "extra"
    (extra_dir / "foo").mkdir(parents=True)
    (extra_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: extra version\n---\n",
        encoding="utf-8",
    )

    # Full pipeline: resolve → discover → render
    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(extra_dir)],
    )
    skills = await discover_skills_from_roots(scoped)
    rendered = format_skills_for_prompt(skills)

    # Terminal assertions — the PR's entire value rides on these passing.

    # (a) ``foo`` is rendered exactly once.
    assert rendered.count("\n- foo\n") == 1

    # (b) ``foo`` appears under ``### Project``, not under any other scope.
    project_section_start = rendered.index("### Project")
    next_header = rendered.find("### ", project_section_start + 1)
    project_section = (
        rendered[project_section_start:next_header]
        if next_header != -1
        else rendered[project_section_start:]
    )
    assert "foo" in project_section

    # (c) Path points at the project's SKILL.md, not any other scope's.
    assert str(proj_foo_md) in rendered

    # (d) The description is the project version.
    assert "project version" in rendered

    # (e) None of the shadowed versions leak into the rendered prompt.
    assert "builtin version" not in rendered
    assert "user version" not in rendered
    assert "extra version" not in rendered

    # (f) Defence-in-depth: also assert the Skill object itself carries
    # project scope — a regression here would silently render under the wrong heading.
    by_name = {s.name: s for s in skills}
    assert by_name["foo"].scope == "project"
