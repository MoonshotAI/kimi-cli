"""Tests for skill discovery and formatting behavior."""

import sys
from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.skill import (
    Skill,
    discover_skills,
    discover_skills_from_roots,
    find_project_skills_dirs,
    find_user_skills_dirs,
    get_builtin_skills_dir,
    resolve_skills_roots,
)


def _write_skill(skill_dir: Path, content: str) -> None:
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")


@pytest.mark.asyncio
async def test_discover_skills_parses_frontmatter_and_defaults(tmp_path):
    root = tmp_path / "skills"
    root.mkdir()

    _write_skill(
        root / "alpha",
        """---
name: alpha-skill
description: Alpha description
---
""",
    )
    _write_skill(root / "beta", "# No frontmatter")

    root_path = KaosPath.unsafe_from_local_path(root)
    skills = await discover_skills(root_path)
    base_dir = KaosPath.unsafe_from_local_path(Path("/path/to"))
    for skill in skills:
        relative_dir = skill.dir.relative_to(root_path)
        skill.dir = base_dir / relative_dir

    assert skills == snapshot(
        [
            Skill(
                name="alpha-skill",
                description="Alpha description",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/alpha")),
                flow=None,
            ),
            Skill(
                name="beta",
                description="No description provided.",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/beta")),
                flow=None,
            ),
        ]
    )


@pytest.mark.asyncio
async def test_discover_skills_parses_flow_type(tmp_path):
    root = tmp_path / "skills"
    root.mkdir()

    _write_skill(
        root / "flowy",
        """---
name: flowy
description: Flow skill
type: flow
---
```mermaid
flowchart TD
BEGIN([BEGIN]) --> A[Hello]
A --> END([END])
```
""",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root))

    assert len(skills) == 1
    assert skills[0].type == "flow"
    assert skills[0].flow is not None
    assert skills[0].flow.begin_id == "BEGIN"


@pytest.mark.asyncio
async def test_discover_skills_flow_parse_failure_falls_back(tmp_path):
    root = tmp_path / "skills"
    root.mkdir()

    _write_skill(
        root / "broken-flow",
        """---
name: broken-flow
description: Broken flow skill
type: flow
---
```mermaid
flowchart TD
A --> B
```
""",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root))

    assert len(skills) == 1
    assert skills[0].type == "standard"
    assert skills[0].flow is None


@pytest.mark.asyncio
async def test_discover_skills_from_roots_prefers_earlier_dirs(tmp_path):
    root = tmp_path / "root"
    system_dir = root / "system"
    user_dir = root / "user"
    system_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)

    _write_skill(
        system_dir / "shared",
        """---
name: shared
description: System version
---
""",
    )
    _write_skill(
        user_dir / "shared",
        """---
name: shared
description: User version
---
""",
    )

    root_path = KaosPath.unsafe_from_local_path(root)
    skills = await discover_skills_from_roots(
        [
            KaosPath.unsafe_from_local_path(system_dir),
            KaosPath.unsafe_from_local_path(user_dir),
        ]
    )
    base_dir = KaosPath.unsafe_from_local_path(Path("/path/to"))
    for skill in skills:
        relative_dir = skill.dir.relative_to(root_path)
        skill.dir = base_dir / relative_dir

    assert skills == snapshot(
        [
            Skill(
                name="shared",
                description="System version",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/system/shared")),
                flow=None,
            )
        ]
    )


@pytest.mark.asyncio
async def test_resolve_skills_roots_uses_layers(monkeypatch, tmp_path):
    home_dir = tmp_path / "home"
    user_dir = home_dir / ".config" / "agents" / "skills"
    user_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    # Redirect share dir so plugins dir doesn't interfere
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    project_dir = work_dir / ".agents" / "skills"
    project_dir.mkdir(parents=True)

    roots = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))

    assert roots == [
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
        KaosPath.unsafe_from_local_path(user_dir),
        KaosPath.unsafe_from_local_path(project_dir),
    ]


@pytest.mark.asyncio
async def test_resolve_skills_roots_skills_dirs_override_discovery(tmp_path, monkeypatch):
    """Extra dirs override user/project discovery, not append to them."""
    home_dir = tmp_path / "home"
    user_dir = home_dir / ".config" / "agents" / "skills"
    user_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    work_dir = tmp_path / "project"
    project_dir = work_dir / ".agents" / "skills"
    project_dir.mkdir(parents=True)

    extra_a = tmp_path / "extra_a"
    extra_a.mkdir()
    extra_b = tmp_path / "extra_b"
    extra_b.mkdir()

    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    roots = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        skills_dirs=[
            KaosPath.unsafe_from_local_path(extra_a),
            KaosPath.unsafe_from_local_path(extra_b),
        ],
    )

    # extra dirs replace user/project discovery
    assert roots == [
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
        KaosPath.unsafe_from_local_path(extra_a),
        KaosPath.unsafe_from_local_path(extra_b),
    ]


@pytest.mark.asyncio
async def test_resolve_skills_roots_empty_skills_dirs(tmp_path, monkeypatch):
    """Empty skills_dirs behaves same as None."""
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    roots_none = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(tmp_path),
        skills_dirs=None,
    )
    roots_empty = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(tmp_path),
        skills_dirs=[],
    )

    assert roots_none == roots_empty


@pytest.mark.asyncio
async def test_discover_skills_from_roots_first_wins(tmp_path):
    """When the same skill name appears in multiple roots, the first root wins."""
    # Root A has skill "greet" with description "A"
    root_a = tmp_path / "root_a" / "greet"
    root_a.mkdir(parents=True)
    (root_a / "SKILL.md").write_text(
        "---\nname: greet\ndescription: A\n---\nHello from A",
        encoding="utf-8",
    )

    # Root B has skill "greet" with description "B"
    root_b = tmp_path / "root_b" / "greet"
    root_b.mkdir(parents=True)
    (root_b / "SKILL.md").write_text(
        "---\nname: greet\ndescription: B\n---\nHello from B",
        encoding="utf-8",
    )

    skills = await discover_skills_from_roots(
        [
            KaosPath.unsafe_from_local_path(tmp_path / "root_a"),
            KaosPath.unsafe_from_local_path(tmp_path / "root_b"),
        ]
    )

    assert len(skills) == 1
    assert skills[0].description == "A"


# ---------------------------------------------------------------------------
# Bug fix tests: empty generic dir should not shadow brand skills
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_find_user_skills_dirs_empty_generic_does_not_shadow_brand(monkeypatch, tmp_path):
    """Core bug: empty ~/.config/agents/skills should NOT hide ~/.kimi/skills."""
    home_dir = tmp_path / "home"
    generic_dir = home_dir / ".config" / "agents" / "skills"
    generic_dir.mkdir(parents=True)  # exists but empty

    brand_dir = home_dir / ".kimi" / "skills"
    brand_dir.mkdir(parents=True)
    _write_skill(brand_dir / "my-skill", "---\nname: my-skill\ndescription: works\n---\n")

    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs()
    # Both dirs should be returned: brand (has skills) + generic (empty)
    assert len(dirs) == 2
    assert dirs[0] == KaosPath.unsafe_from_local_path(brand_dir)
    assert dirs[1] == KaosPath.unsafe_from_local_path(generic_dir)


@pytest.mark.asyncio
async def test_find_user_skills_dirs_none_exist(monkeypatch, tmp_path):
    """No skills dirs exist → empty list."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")

    dirs = await find_user_skills_dirs()
    assert dirs == []


@pytest.mark.asyncio
async def test_find_user_skills_dirs_only_brand(monkeypatch, tmp_path):
    """Only brand dir exists → returned alone."""
    home_dir = tmp_path / "home"
    brand_dir = home_dir / ".kimi" / "skills"
    brand_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs()
    assert dirs == [KaosPath.unsafe_from_local_path(brand_dir)]


@pytest.mark.asyncio
async def test_find_user_skills_dirs_only_generic(monkeypatch, tmp_path):
    """Only generic dir exists → returned alone."""
    home_dir = tmp_path / "home"
    generic_dir = home_dir / ".agents" / "skills"
    generic_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs()
    assert dirs == [KaosPath.unsafe_from_local_path(generic_dir)]


@pytest.mark.asyncio
async def test_find_user_skills_dirs_brand_wins_over_generic_same_skill(monkeypatch, tmp_path):
    """When both groups have skills, brand root comes first → its skills win."""
    home_dir = tmp_path / "home"
    generic_dir = home_dir / ".config" / "agents" / "skills"
    generic_dir.mkdir(parents=True)
    _write_skill(generic_dir / "greet", "---\nname: greet\ndescription: generic version\n---\n")

    brand_dir = home_dir / ".kimi" / "skills"
    brand_dir.mkdir(parents=True)
    _write_skill(brand_dir / "greet", "---\nname: greet\ndescription: brand version\n---\n")

    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs()
    assert dirs[0] == KaosPath.unsafe_from_local_path(brand_dir)
    assert dirs[1] == KaosPath.unsafe_from_local_path(generic_dir)

    # Verify discover_skills_from_roots uses brand version
    skills = await discover_skills_from_roots(dirs)
    assert len(skills) == 1
    assert skills[0].description == "brand version"


@pytest.mark.asyncio
async def test_find_user_skills_dirs_brand_group_prefers_kimi_over_claude(monkeypatch, tmp_path):
    """Brand group: ~/.kimi/skills takes priority over ~/.claude/skills."""
    home_dir = tmp_path / "home"
    kimi_dir = home_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs()
    # Only kimi should be selected (first existing in brand group)
    assert KaosPath.unsafe_from_local_path(kimi_dir) in dirs
    assert KaosPath.unsafe_from_local_path(claude_dir) not in dirs


@pytest.mark.asyncio
async def test_find_project_skills_dirs_merge(tmp_path):
    """Project layer: brand + generic dirs both returned."""
    work_dir = tmp_path / "project"
    generic_dir = work_dir / ".agents" / "skills"
    generic_dir.mkdir(parents=True)
    brand_dir = work_dir / ".kimi" / "skills"
    brand_dir.mkdir(parents=True)

    dirs = await find_project_skills_dirs(KaosPath.unsafe_from_local_path(work_dir))
    assert len(dirs) == 2
    assert dirs[0] == KaosPath.unsafe_from_local_path(brand_dir)
    assert dirs[1] == KaosPath.unsafe_from_local_path(generic_dir)


@pytest.mark.asyncio
async def test_find_project_skills_dirs_brand_prefers_kimi(tmp_path):
    """Project layer brand group: .kimi/skills wins over .claude/skills."""
    work_dir = tmp_path / "project"
    kimi_dir = work_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = work_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)

    dirs = await find_project_skills_dirs(KaosPath.unsafe_from_local_path(work_dir))
    assert len(dirs) == 1
    assert dirs[0] == KaosPath.unsafe_from_local_path(kimi_dir)


@pytest.mark.asyncio
async def test_resolve_skills_roots_merges_user_and_project(monkeypatch, tmp_path):
    """Exact ordering: builtin → user_brand → user_generic → proj_brand → proj_generic."""
    home_dir = tmp_path / "home"
    user_generic = home_dir / ".config" / "agents" / "skills"
    user_generic.mkdir(parents=True)
    user_brand = home_dir / ".kimi" / "skills"
    user_brand.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    proj_generic = work_dir / ".agents" / "skills"
    proj_generic.mkdir(parents=True)
    proj_brand = work_dir / ".kimi" / "skills"
    proj_brand.mkdir(parents=True)

    roots = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    assert roots == [
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
        KaosPath.unsafe_from_local_path(user_brand),
        KaosPath.unsafe_from_local_path(user_generic),
        KaosPath.unsafe_from_local_path(proj_brand),
        KaosPath.unsafe_from_local_path(proj_generic),
    ]


@pytest.mark.asyncio
async def test_empty_generic_brand_skills_visible_end_to_end(monkeypatch, tmp_path):
    """Core bug e2e: empty generic dir must not hide brand skills through the full pipeline."""
    home_dir = tmp_path / "home"
    generic_dir = home_dir / ".config" / "agents" / "skills"
    generic_dir.mkdir(parents=True)  # exists but empty

    brand_dir = home_dir / ".kimi" / "skills"
    brand_dir.mkdir(parents=True)
    _write_skill(
        brand_dir / "deploy",
        "---\nname: deploy\ndescription: Deploy to prod\n---\n",
    )

    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    roots = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(roots)

    # The brand skill must be discoverable despite the empty generic dir
    skill_names = [s.name for s in skills]
    assert "deploy" in skill_names


@pytest.mark.asyncio
async def test_find_user_skills_dirs_generic_group_prefers_config_over_agents(
    monkeypatch, tmp_path
):
    """Generic group: ~/.config/agents/skills wins over ~/.agents/skills."""
    home_dir = tmp_path / "home"
    config_dir = home_dir / ".config" / "agents" / "skills"
    config_dir.mkdir(parents=True)
    agents_dir = home_dir / ".agents" / "skills"
    agents_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs()
    assert KaosPath.unsafe_from_local_path(config_dir) in dirs
    assert KaosPath.unsafe_from_local_path(agents_dir) not in dirs


# ---------------------------------------------------------------------------
# merge_brands tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_find_user_skills_dirs_merge_brands_kimi_and_claude(monkeypatch, tmp_path):
    """merge_brands=True: kimi + claude both exist → both returned, kimi first."""
    home_dir = tmp_path / "home"
    kimi_dir = home_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs(merge_brands=True)
    assert KaosPath.unsafe_from_local_path(kimi_dir) in dirs
    assert KaosPath.unsafe_from_local_path(claude_dir) in dirs
    # kimi before claude
    kimi_idx = dirs.index(KaosPath.unsafe_from_local_path(kimi_dir))
    claude_idx = dirs.index(KaosPath.unsafe_from_local_path(claude_dir))
    assert kimi_idx < claude_idx


@pytest.mark.asyncio
async def test_find_user_skills_dirs_merge_brands_all_three(monkeypatch, tmp_path):
    """merge_brands=True: all three brand dirs → [kimi, claude, codex]."""
    home_dir = tmp_path / "home"
    kimi_dir = home_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    codex_dir = home_dir / ".codex" / "skills"
    codex_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs(merge_brands=True)
    brand_dirs = dirs  # no generic dirs created
    assert len(brand_dirs) == 3
    assert brand_dirs[0] == KaosPath.unsafe_from_local_path(kimi_dir)
    assert brand_dirs[1] == KaosPath.unsafe_from_local_path(claude_dir)
    assert brand_dirs[2] == KaosPath.unsafe_from_local_path(codex_dir)


@pytest.mark.asyncio
async def test_find_user_skills_dirs_merge_brands_only_claude(monkeypatch, tmp_path):
    """merge_brands=True: only claude exists → [claude]."""
    home_dir = tmp_path / "home"
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs(merge_brands=True)
    assert dirs == [KaosPath.unsafe_from_local_path(claude_dir)]


@pytest.mark.asyncio
async def test_find_user_skills_dirs_merge_brands_same_skill_kimi_wins(monkeypatch, tmp_path):
    """merge_brands=True + same skill name → kimi version wins via discover."""
    home_dir = tmp_path / "home"
    kimi_dir = home_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    _write_skill(
        kimi_dir / "deploy",
        "---\nname: deploy\ndescription: kimi deploy\n---\n",
    )
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    _write_skill(
        claude_dir / "deploy",
        "---\nname: deploy\ndescription: claude deploy\n---\n",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    dirs = await find_user_skills_dirs(merge_brands=True)
    skills = await discover_skills_from_roots(dirs)
    assert len(skills) == 1
    assert skills[0].description == "kimi deploy"


@pytest.mark.asyncio
async def test_find_project_skills_dirs_merge_brands(tmp_path):
    """Project layer merge_brands=True: all brand dirs returned."""
    work_dir = tmp_path / "project"
    kimi_dir = work_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = work_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)

    dirs = await find_project_skills_dirs(
        KaosPath.unsafe_from_local_path(work_dir), merge_brands=True
    )
    assert KaosPath.unsafe_from_local_path(kimi_dir) in dirs
    assert KaosPath.unsafe_from_local_path(claude_dir) in dirs


def test_get_builtin_skills_dir_frozen_env(monkeypatch, tmp_path):
    """In a PyInstaller frozen env, get_builtin_skills_dir uses sys._MEIPASS."""
    fake_meipass = tmp_path / "_meipass"
    fake_meipass.mkdir()

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(fake_meipass), raising=False)

    result = get_builtin_skills_dir()
    assert result == fake_meipass / "kimi_cli" / "skills"


def test_get_builtin_skills_dir_normal_env():
    """In a normal (non-frozen) env, get_builtin_skills_dir uses __file__."""
    result = get_builtin_skills_dir()
    # Should resolve relative to the skill package
    assert result.name == "skills"
    assert result.parent.name == "kimi_cli"


@pytest.mark.asyncio
async def test_resolve_skills_roots_passes_merge_brands(monkeypatch, tmp_path):
    """resolve_skills_roots forwards merge_brands to finders."""
    home_dir = tmp_path / "home"
    kimi_dir = home_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"

    # Without merge_brands: only kimi
    roots_default = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
    )
    assert KaosPath.unsafe_from_local_path(kimi_dir) in roots_default
    assert KaosPath.unsafe_from_local_path(claude_dir) not in roots_default

    # With merge_brands: both
    roots_merged = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        merge_brands=True,
    )
    assert KaosPath.unsafe_from_local_path(kimi_dir) in roots_merged
    assert KaosPath.unsafe_from_local_path(claude_dir) in roots_merged
