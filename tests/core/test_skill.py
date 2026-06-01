"""Tests for skill discovery and formatting behavior."""

import sys
from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.skill import (
    ScopedSkillsRoot,
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


def _roots_of(scoped: list[ScopedSkillsRoot]) -> list[KaosPath]:
    """Strip scope labels from a scoped root list; convenience for tests that
    only care about the root paths, not their scope.
    """
    return [s.root for s in scoped]


def _as_user(dirs: list[KaosPath]) -> list[ScopedSkillsRoot]:
    """Wrap a list of KaosPath into ScopedSkillsRoot with scope='user'. Used by
    tests that only exercise discovery ordering, not scope semantics.
    """
    return [ScopedSkillsRoot(root=d, scope="user") for d in dirs]


def _scoped(**by_scope: list[KaosPath]) -> list[ScopedSkillsRoot]:
    """Build a scoped-root list from keyword args like ``_scoped(project=[...], user=[...])``.

    Order of kwargs determines the priority order in the resulting list.
    """
    out: list[ScopedSkillsRoot] = []
    for scope, dirs in by_scope.items():
        for d in dirs:
            out.append(ScopedSkillsRoot(root=d, scope=scope))  # type: ignore[arg-type]
    return out


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
    skills = await discover_skills(root_path, scope="user")
    base_dir = KaosPath.unsafe_from_local_path(Path("/path/to"))
    for skill in skills:
        relative_dir = skill.dir.relative_to(root_path)
        skill.dir = base_dir / relative_dir
        # Rebase skill_md_file so the snapshot is deterministic across machines.
        skill.skill_md_file = base_dir / skill.skill_md_file.relative_to(root_path)

    # beta has no frontmatter `description:` — falls back to the first
    # meaningful body line, "# No frontmatter". This matches the unified rule
    # that both subdirectory and flat .md skills follow the same
    # frontmatter → body-first-line → placeholder chain.
    assert skills == snapshot(
        [
            Skill(
                name="alpha-skill",
                description="Alpha description",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/alpha")),
                skill_md_file=KaosPath.unsafe_from_local_path(Path("/path/to/alpha/SKILL.md")),
                flow=None,
                scope="user",
            ),
            Skill(
                name="beta",
                description="# No frontmatter",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/beta")),
                skill_md_file=KaosPath.unsafe_from_local_path(Path("/path/to/beta/SKILL.md")),
                flow=None,
                scope="user",
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

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

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

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

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
            ScopedSkillsRoot(root=KaosPath.unsafe_from_local_path(system_dir), scope="builtin"),
            ScopedSkillsRoot(root=KaosPath.unsafe_from_local_path(user_dir), scope="user"),
        ]
    )
    base_dir = KaosPath.unsafe_from_local_path(Path("/path/to"))
    for skill in skills:
        relative_dir = skill.dir.relative_to(root_path)
        skill.dir = base_dir / relative_dir
        skill.skill_md_file = base_dir / skill.skill_md_file.relative_to(root_path)

    assert skills == snapshot(
        [
            Skill(
                name="shared",
                description="System version",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/system/shared")),
                skill_md_file=KaosPath.unsafe_from_local_path(
                    Path("/path/to/system/shared/SKILL.md")
                ),
                flow=None,
                scope="builtin",
            )
        ]
    )


@pytest.mark.asyncio
async def test_resolve_skills_roots_uses_layers(monkeypatch, tmp_path):
    """Priority order: project > user > extra(plugins) > builtin.

    Fix 7 (scope 优先级): higher-priority roots come first so
    ``discover_skills_from_roots``'s "first wins" semantics put the most
    specific scope ahead of general ones.
    """
    home_dir = tmp_path / "home"
    user_dir = home_dir / ".config" / "agents" / "skills"
    user_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    # Redirect share dir so plugins dir doesn't interfere
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    project_dir = work_dir / ".agents" / "skills"
    project_dir.mkdir(parents=True)

    roots = _roots_of(await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir)))

    # Project (most specific) first, then user, then builtin (least specific).
    assert roots == [
        KaosPath.unsafe_from_local_path(project_dir),
        KaosPath.unsafe_from_local_path(user_dir),
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
    ]


@pytest.mark.asyncio
async def test_resolve_skills_roots_skills_dirs_override_discovery(tmp_path, monkeypatch):
    """Extra dirs override user/project discovery, not append to them.

    With ``--skills-dir`` set, user/project auto-discovery is skipped. The CLI
    dirs sit at the top of the priority order (they express the user's explicit
    per-run intent) and builtin sits at the bottom.
    """
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

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            skills_dirs=[
                KaosPath.unsafe_from_local_path(extra_a),
                KaosPath.unsafe_from_local_path(extra_b),
            ],
        )
    )

    # CLI-supplied dirs first (user's explicit intent), then builtin.
    assert roots == [
        KaosPath.unsafe_from_local_path(extra_a),
        KaosPath.unsafe_from_local_path(extra_b),
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
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
        _as_user(
            [
                KaosPath.unsafe_from_local_path(tmp_path / "root_a"),
                KaosPath.unsafe_from_local_path(tmp_path / "root_b"),
            ]
        )
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
    skills = await discover_skills_from_roots(_as_user(dirs))
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
    """Exact ordering (Fix 7): proj_brand → proj_generic → user_brand → user_generic → builtin.

    Project dirs come first (most specific), then user, then builtin. Inside a
    single scope, brand dirs precede generic dirs as before.
    """
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

    roots = _roots_of(await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir)))
    assert roots == [
        KaosPath.unsafe_from_local_path(proj_brand),
        KaosPath.unsafe_from_local_path(proj_generic),
        KaosPath.unsafe_from_local_path(user_brand),
        KaosPath.unsafe_from_local_path(user_generic),
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
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
    scoped = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(scoped)

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
    skills = await discover_skills_from_roots(_as_user(dirs))
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
    roots_default = _roots_of(await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir)))
    assert KaosPath.unsafe_from_local_path(kimi_dir) in roots_default
    assert KaosPath.unsafe_from_local_path(claude_dir) not in roots_default

    # With merge_brands: both
    roots_merged = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            merge_brands=True,
        )
    )
    assert KaosPath.unsafe_from_local_path(kimi_dir) in roots_merged
    assert KaosPath.unsafe_from_local_path(claude_dir) in roots_merged


# ---------------------------------------------------------------------------
# Fix C1: flat .md skill files (no <name>/SKILL.md subdirectory required)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_discover_skills_flat_md_basic(tmp_path):
    """A flat .md file in skills/ is picked up as a skill."""
    root = tmp_path / "skills"
    root.mkdir()
    (root / "demo-ui-components.md").write_text(
        "---\nname: demo-ui-components\ndescription: Demo UI\n---\nBody",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

    assert len(skills) == 1
    assert skills[0].name == "demo-ui-components"
    assert skills[0].description == "Demo UI"


@pytest.mark.asyncio
async def test_discover_skills_flat_md_name_defaults_to_stem(tmp_path):
    """Without a frontmatter ``name`` field, stem of the filename is used."""
    root = tmp_path / "skills"
    root.mkdir()
    (root / "my-thing.md").write_text(
        "---\ndescription: Something\n---\nBody",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

    assert len(skills) == 1
    assert skills[0].name == "my-thing"
    assert skills[0].description == "Something"


@pytest.mark.asyncio
async def test_discover_skills_flat_md_description_from_first_line_fallback(tmp_path):
    """Without frontmatter, description falls back to the first non-empty content line."""
    root = tmp_path / "skills"
    root.mkdir()
    (root / "plain.md").write_text(
        "\n\nThis is the headline description.\n\nMore body text here.\n",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

    assert len(skills) == 1
    assert skills[0].name == "plain"
    # description falls back to first non-empty line
    assert "headline description" in skills[0].description.lower()


@pytest.mark.asyncio
async def test_discover_skills_flat_md_frontmatter_description_wins_over_body(tmp_path):
    """Frontmatter ``description`` takes priority over any body first-line fallback."""
    root = tmp_path / "skills"
    root.mkdir()
    (root / "a.md").write_text(
        "---\ndescription: From frontmatter\n---\nBody first line\n",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

    assert len(skills) == 1
    assert skills[0].description == "From frontmatter"


@pytest.mark.asyncio
async def test_discover_skills_flat_and_subdir_mixed(tmp_path):
    """Both forms coexist; each is discovered once."""
    root = tmp_path / "skills"
    root.mkdir()

    # Subdir form
    _write_skill(
        root / "subdir-skill",
        "---\nname: subdir-skill\ndescription: From subdir\n---\n",
    )

    # Flat form
    (root / "flat-skill.md").write_text(
        "---\nname: flat-skill\ndescription: From flat\n---\n",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    names = sorted(s.name for s in skills)
    assert names == ["flat-skill", "subdir-skill"]


@pytest.mark.asyncio
async def test_discover_skills_flat_and_subdir_same_name_subdir_wins(tmp_path, caplog):
    """When a flat and a subdir skill share a name, subdir wins (with a warning)."""
    root = tmp_path / "skills"
    root.mkdir()

    _write_skill(
        root / "greet",
        "---\nname: greet\ndescription: From subdir\n---\n",
    )
    (root / "greet.md").write_text(
        "---\nname: greet\ndescription: From flat\n---\n",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")

    assert len(skills) == 1
    assert skills[0].description == "From subdir"


@pytest.mark.asyncio
async def test_discover_skills_flat_md_ignores_skill_md_marker_file(tmp_path):
    """A top-level ``SKILL.md`` in the skills/ root is not itself a skill."""
    root = tmp_path / "skills"
    root.mkdir()
    (root / "SKILL.md").write_text(
        "---\nname: not-a-skill\ndescription: accidental\n---\n",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    # The bare SKILL.md at the root must not be registered as a skill
    assert skills == []


# ---------------------------------------------------------------------------
# Fix C2: extra_skill_dirs config knob
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_append(monkeypatch, tmp_path):
    """extra_skill_dirs is additive: appended after builtin + user + project."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()
    extra = tmp_path / "my-extra"
    extra.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=[str(extra)],
        )
    )

    assert KaosPath.unsafe_from_local_path(extra) in roots


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_expand_tilde(monkeypatch, tmp_path):
    """``~`` in extra_skill_dirs is expanded to the user's home."""
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    extra_under_home = home_dir / "my-skills"
    extra_under_home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    monkeypatch.setenv("HOME", str(home_dir))

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=["~/my-skills"],
        )
    )

    assert KaosPath.unsafe_from_local_path(extra_under_home) in roots


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_relative_to_project_root(
    monkeypatch, tmp_path
):
    """A relative entry resolves against the project root (the .git dir), not CWD.

    Scenario: user launches with ``--work-dir <project>/sub/dir`` but the ``.git``
    marker is at ``<project>``. A relative ``./my-dir`` entry must resolve at the
    project root (``<project>/my-dir``), not at the work_dir (``<project>/sub/dir``).
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    project_root = tmp_path / "project"
    project_root.mkdir()
    (project_root / ".git").mkdir()
    work_dir = project_root / "sub" / "dir"
    work_dir.mkdir(parents=True)

    # The actual extra dir is at <project_root>/my-dir, NOT at <work_dir>/my-dir
    extra_at_root = project_root / "my-dir"
    extra_at_root.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=["my-dir"],
        )
    )

    assert KaosPath.unsafe_from_local_path(extra_at_root) in roots
    # Must not have resolved to <work_dir>/my-dir (which doesn't exist)
    assert KaosPath.unsafe_from_local_path(work_dir / "my-dir") not in roots


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_absolute(monkeypatch, tmp_path):
    """Absolute paths are used as-is."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()
    abs_extra = tmp_path / "somewhere" / "else"
    abs_extra.mkdir(parents=True)

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=[str(abs_extra)],
        )
    )

    assert KaosPath.unsafe_from_local_path(abs_extra) in roots


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_missing_path_skipped(monkeypatch, tmp_path):
    """Non-existent extra dirs are silently dropped (no raise, no warning crash)."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()
    real = tmp_path / "real"
    real.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=[str(real), str(tmp_path / "nowhere"), str(tmp_path / "nope")],
        )
    )

    assert KaosPath.unsafe_from_local_path(real) in roots
    # Missing paths did not make it into the final roots list
    assert KaosPath.unsafe_from_local_path(tmp_path / "nowhere") not in roots


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_dedup(monkeypatch, tmp_path):
    """Duplicate entries in extra_skill_dirs are collapsed."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()
    real = tmp_path / "real"
    real.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=[str(real), str(real)],
        )
    )

    real_kp = KaosPath.unsafe_from_local_path(real)
    assert roots.count(real_kp) == 1


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_scope(monkeypatch, tmp_path):
    """Skills from extra_skill_dirs carry scope='extra'."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()
    extra = tmp_path / "my-extra"
    extra.mkdir()
    (extra / "xs").mkdir()
    (extra / "xs" / "SKILL.md").write_text(
        "---\nname: xs\ndescription: x\n---\n",
        encoding="utf-8",
    )

    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(extra)],
    )
    skills = await discover_skills_from_roots(scoped)
    by_name = {s.name: s for s in skills}
    assert by_name["xs"].scope == "extra"


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_cli_override_still_wins(monkeypatch, tmp_path):
    """``--skills-dir`` (override) continues to take priority: auto-discovery is
    replaced, but extra_skill_dirs is still honoured in addition to the override.
    """
    # Note: this locks in the current semantics — extra_skill_dirs is additive
    # and does not conflict with --skills-dir's override role.
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()
    cli_dir = tmp_path / "cli"
    cli_dir.mkdir()
    extra_dir = tmp_path / "extra"
    extra_dir.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            skills_dirs=[KaosPath.unsafe_from_local_path(cli_dir)],
            extra_skill_dirs=[str(extra_dir)],
        )
    )

    assert KaosPath.unsafe_from_local_path(cli_dir) in roots
    assert KaosPath.unsafe_from_local_path(extra_dir) in roots


# ---------------------------------------------------------------------------
# Fix 7 smoking-gun tests: scope priority Project > User > Extra > Built-in
# ---------------------------------------------------------------------------
#
# These assertions lock the contract that ``system.md`` promises to the model:
# when a skill name is defined in multiple scopes, the more specific scope
# wins. Without these, it's easy to silently regress the ordering in
# ``resolve_skills_roots`` and have the system prompt lie to the model.


@pytest.mark.asyncio
async def test_project_scope_skill_overrides_builtin_with_same_name(monkeypatch, tmp_path):
    """Project > Built-in: a project-local skill wins over a same-named builtin."""
    # Fake the bundled builtin skills dir via the module-level getter
    import kimi_cli.skill as skill_mod

    builtin_dir = tmp_path / "fake_builtin"
    builtin_dir.mkdir()
    (builtin_dir / "foo").mkdir()
    (builtin_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: builtin version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(skill_mod, "get_builtin_skills_dir", lambda: builtin_dir)

    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    proj_dir = work_dir / ".kimi" / "skills"
    proj_dir.mkdir(parents=True)
    (proj_dir / "foo").mkdir()
    (proj_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: project version\n---\n",
        encoding="utf-8",
    )

    scoped = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(scoped)
    by_name = {s.name: s for s in skills}

    assert by_name["foo"].scope == "project"
    assert by_name["foo"].description == "project version"


@pytest.mark.asyncio
async def test_user_scope_skill_overrides_builtin_with_same_name(monkeypatch, tmp_path):
    """User > Built-in: a user-scope skill wins over a same-named builtin."""
    import kimi_cli.skill as skill_mod

    builtin_dir = tmp_path / "fake_builtin"
    builtin_dir.mkdir()
    (builtin_dir / "foo").mkdir()
    (builtin_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: builtin version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(skill_mod, "get_builtin_skills_dir", lambda: builtin_dir)

    home_dir = tmp_path / "home"
    user_dir = home_dir / ".kimi" / "skills"
    user_dir.mkdir(parents=True)
    (user_dir / "foo").mkdir()
    (user_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: user version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    scoped = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(scoped)
    by_name = {s.name: s for s in skills}

    assert by_name["foo"].scope == "user"
    assert by_name["foo"].description == "user version"


@pytest.mark.asyncio
async def test_project_scope_skill_overrides_user_with_same_name(monkeypatch, tmp_path):
    """Project > User: when both define 'foo', the project version wins."""
    home_dir = tmp_path / "home"
    user_dir = home_dir / ".kimi" / "skills"
    user_dir.mkdir(parents=True)
    (user_dir / "foo").mkdir()
    (user_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: user version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    proj_dir = work_dir / ".kimi" / "skills"
    proj_dir.mkdir(parents=True)
    (proj_dir / "foo").mkdir()
    (proj_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: project version\n---\n",
        encoding="utf-8",
    )

    scoped = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(scoped)
    by_name = {s.name: s for s in skills}

    assert by_name["foo"].scope == "project"
    assert by_name["foo"].description == "project version"


@pytest.mark.asyncio
async def test_extra_scope_skill_overrides_builtin_with_same_name(monkeypatch, tmp_path):
    """Extra > Built-in: an extra_skill_dirs skill wins over a same-named builtin."""
    import kimi_cli.skill as skill_mod

    builtin_dir = tmp_path / "fake_builtin"
    builtin_dir.mkdir()
    (builtin_dir / "foo").mkdir()
    (builtin_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: builtin version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(skill_mod, "get_builtin_skills_dir", lambda: builtin_dir)

    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    extra_dir = tmp_path / "extra"
    (extra_dir / "foo").mkdir(parents=True)
    (extra_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: extra version\n---\n",
        encoding="utf-8",
    )

    work_dir = tmp_path / "project"
    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(extra_dir)],
    )
    skills = await discover_skills_from_roots(scoped)
    by_name = {s.name: s for s in skills}

    assert by_name["foo"].scope == "extra"
    assert by_name["foo"].description == "extra version"


@pytest.mark.asyncio
async def test_user_scope_skill_overrides_extra_with_same_name(monkeypatch, tmp_path):
    """User > Extra: a user-scope skill wins over an extra_skill_dirs skill with the same name."""
    home_dir = tmp_path / "home"
    user_dir = home_dir / ".kimi" / "skills"
    user_dir.mkdir(parents=True)
    (user_dir / "foo").mkdir()
    (user_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: user version\n---\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    extra_dir = tmp_path / "extra"
    (extra_dir / "foo").mkdir(parents=True)
    (extra_dir / "foo" / "SKILL.md").write_text(
        "---\nname: foo\ndescription: extra version\n---\n",
        encoding="utf-8",
    )

    work_dir = tmp_path / "project"
    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(extra_dir)],
    )
    skills = await discover_skills_from_roots(scoped)
    by_name = {s.name: s for s in skills}

    assert by_name["foo"].scope == "user"
    assert by_name["foo"].description == "user version"


# ---------------------------------------------------------------------------
# Fix 2: description fallback unified across subdir / flat forms
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_discover_subdir_skill_no_frontmatter_falls_back_to_body_line(tmp_path):
    """Subdirectory SKILL.md without frontmatter description falls back to body line.

    Before fix 2, subdirectory skills used ``"No description provided."`` while
    flat skills used the body-first-line fallback. The behaviour is now
    unified — both forms apply the same chain:
    frontmatter → body first line → placeholder.
    """
    root = tmp_path / "skills"
    root.mkdir()
    _write_skill(
        root / "bare",
        "This is a skill body without frontmatter at all.\nSecond line.\n",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    assert len(skills) == 1
    assert skills[0].description == "This is a skill body without frontmatter at all."


@pytest.mark.asyncio
async def test_discover_skill_description_truncated_at_body_fallback(tmp_path):
    """Body-derived descriptions are truncated to 240 chars with an ellipsis.

    The spec caps ``description`` at 1024 chars, but fallbacks are more
    speculative (we're picking a random first body line), so a tighter limit
    keeps the system prompt compact.
    """
    root = tmp_path / "skills"
    root.mkdir()
    long_line = "a" * 300  # 300 chars, no frontmatter, fallback triggers
    _write_skill(root / "long", long_line)

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    assert len(skills) == 1
    desc = skills[0].description
    # 240 chars (239 content + '…')
    assert len(desc) == 240
    assert desc.endswith("…")


@pytest.mark.asyncio
async def test_discover_skill_description_frontmatter_not_truncated(tmp_path):
    """The 240-char cap applies only to the body-fallback path. An explicit
    frontmatter ``description`` of up to the spec limit (1024) is kept as-is.
    """
    root = tmp_path / "skills"
    root.mkdir()
    long_desc = "b" * 900
    _write_skill(
        root / "long",
        f"---\nname: long\ndescription: {long_desc}\n---\nBody here\n",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    assert len(skills) == 1
    assert skills[0].description == long_desc


# ---------------------------------------------------------------------------
# Fix 5: dedup canonicalization for extra_skill_dirs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_symlink_dedup(monkeypatch, tmp_path):
    """A symlinked extra dir collapses to the canonical target (no phantom dup).

    Two ``extra_skill_dirs`` entries — one pointing at the real directory, one
    via a symlink to the same place — must register as a single root; otherwise
    the system prompt would list the same skills twice under the Extra scope.
    ``KaosPath.canonical()`` does not walk symlinks, so this relies on
    ``_append`` running a ``Path.resolve()`` pass on local backends.
    """
    import kimi_cli.skill as skill_mod

    # Suppress built-in skills so we can make a tight ``len(roots) == 1``
    # assertion — the point of this test is exactly that the real dir and the
    # symlinked dir collapse to one root.
    monkeypatch.setattr(skill_mod, "_supports_builtin_skills", lambda: False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=[str(real), str(link)],
        )
    )

    # Both entries must dedupe to exactly one root; neither the real nor the
    # symlink version should appear twice in any form.
    assert len(roots) == 1
    # And that single root must be the real target (not the symlink path).
    assert Path(str(roots[0])).resolve() == real.resolve()


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_trailing_slash_dedup(monkeypatch, tmp_path):
    """Entries that differ only by a trailing slash collapse to one root."""
    import kimi_cli.skill as skill_mod

    # Suppress built-in skills so we can make a tight ``len(roots) == 1``
    # assertion — otherwise the built-in roots would also land in ``roots``
    # and we would only be able to assert ``real_kp`` is present once, which
    # is weaker than what this test is meant to lock.
    monkeypatch.setattr(skill_mod, "_supports_builtin_skills", lambda: False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    real = tmp_path / "real"
    real.mkdir()

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    roots = _roots_of(
        await resolve_skills_roots(
            KaosPath.unsafe_from_local_path(work_dir),
            extra_skill_dirs=[str(real), str(real) + "/"],
        )
    )
    # Both entries must collapse to exactly one root — no duplicate slot for
    # the trailing-slash variant.
    assert len(roots) == 1
    real_kp = KaosPath.unsafe_from_local_path(real)
    assert roots.count(real_kp) == 1


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_symlink_scope_is_extra(monkeypatch, tmp_path):
    """After symlink dedup the surviving root still carries ``scope='extra'``."""
    import kimi_cli.skill as skill_mod

    monkeypatch.setattr(skill_mod, "_supports_builtin_skills", lambda: False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(real), str(link)],
    )

    assert len(scoped) == 1
    assert scoped[0].scope == "extra"


@pytest.mark.asyncio
async def test_resolve_skills_roots_extra_skill_dirs_symlink_stored_root_is_realpath(
    monkeypatch, tmp_path
):
    """The stored root is the real target path, not the symlink the user typed.

    Important for the system prompt's ``Path:`` field: showing the real path
    keeps ``Path:`` lines stable across users who happen to add different
    symlinks to the same underlying directory.
    """
    import kimi_cli.skill as skill_mod

    monkeypatch.setattr(skill_mod, "_supports_builtin_skills", lambda: False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    # Only pass the symlink — the stored root should still be the real path.
    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(link)],
    )

    assert len(scoped) == 1
    stored = Path(str(scoped[0].root))
    assert stored == real.resolve()
    # Crucially, the symlink path does NOT appear in the stored root.
    assert stored != link


# ---------------------------------------------------------------------------
# Fix 8: OSError resilience during discovery
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_discover_skills_permission_denied_returns_empty(monkeypatch, tmp_path):
    """If ``iterdir`` raises PermissionError, discovery logs and returns [] —
    it does not bubble the exception up and crash the whole session.
    """
    import kimi_cli.skill as skill_mod

    # Build a real dir so the initial is_dir() check succeeds.
    root = tmp_path / "locked"
    root.mkdir()
    root_kp = KaosPath.unsafe_from_local_path(root)

    # Patch iterdir to raise PermissionError the way a 0o000 dir would.
    async def _raising_iterdir(self):  # type: ignore[no-untyped-def]
        raise PermissionError("simulated")
        yield  # make this a generator (unreachable)

    monkeypatch.setattr(type(root_kp), "iterdir", _raising_iterdir)

    skills = await skill_mod.discover_skills(root_kp, scope="extra")
    assert skills == []


# ---------------------------------------------------------------------------
# Stage-4 audit: missing-scenario coverage
# ---------------------------------------------------------------------------
#
# The following tests close review gaps in areas where the existing suite
# was only partially explicit. They exist to stop regressions, not to add
# net-new behaviour.


@pytest.mark.asyncio
async def test_skills_dirs_override_excludes_user_and_project_scopes(monkeypatch, tmp_path):
    """``--skills-dir`` fully replaces user + project auto-discovery.

    A foo skill placed under both user and project scopes must NOT leak
    through when the caller supplies ``skills_dirs`` — the CLI override is
    meant to be an explicit, closed set. Complements
    ``test_resolve_skills_roots_skills_dirs_override_discovery`` by asserting
    end-to-end that the *discovered skills* don't contain the shadowed ones.
    """
    home_dir = tmp_path / "home"
    user_brand = home_dir / ".kimi" / "skills"
    user_brand.mkdir(parents=True)
    _write_skill(
        user_brand / "foo",
        "---\nname: foo\ndescription: user version\n---\n",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    proj_brand = work_dir / ".kimi" / "skills"
    proj_brand.mkdir(parents=True)
    _write_skill(
        proj_brand / "foo",
        "---\nname: foo\ndescription: project version\n---\n",
    )

    cli_dir = tmp_path / "cli"
    cli_dir.mkdir()
    _write_skill(
        cli_dir / "bar",
        "---\nname: bar\ndescription: cli version\n---\n",
    )

    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        skills_dirs=[KaosPath.unsafe_from_local_path(cli_dir)],
    )
    skills = await discover_skills_from_roots(scoped)
    names = {s.name for s in skills}

    # The CLI skill is present; the shadowed user/project versions are not.
    assert "bar" in names
    assert "foo" not in names


@pytest.mark.asyncio
async def test_three_scope_conflict_project_wins_over_user_and_builtin(monkeypatch, tmp_path):
    """Builtin + user + project all define ``foo``; project wins; only one entry.

    The three-way conflict is the most realistic regression source (previous
    pairwise smoking-gun tests each cover 2 scopes at a time). Locks in that
    the full pipeline collapses to a single foo tagged ``project``.
    """
    import kimi_cli.skill as skill_mod

    builtin_dir = tmp_path / "fake_builtin"
    builtin_dir.mkdir()
    _write_skill(
        builtin_dir / "foo",
        "---\nname: foo\ndescription: builtin version\n---\n",
    )
    monkeypatch.setattr(skill_mod, "get_builtin_skills_dir", lambda: builtin_dir)

    home_dir = tmp_path / "home"
    user_brand = home_dir / ".kimi" / "skills"
    user_brand.mkdir(parents=True)
    _write_skill(
        user_brand / "foo",
        "---\nname: foo\ndescription: user version\n---\n",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    proj_brand = work_dir / ".kimi" / "skills"
    proj_brand.mkdir(parents=True)
    _write_skill(
        proj_brand / "foo",
        "---\nname: foo\ndescription: project version\n---\n",
    )

    scoped = await resolve_skills_roots(KaosPath.unsafe_from_local_path(work_dir))
    skills = await discover_skills_from_roots(scoped)
    foos = [s for s in skills if s.name == "foo"]

    assert len(foos) == 1
    assert foos[0].scope == "project"
    assert foos[0].description == "project version"


def test_skill_scope_is_required_field(tmp_path):
    """Constructing a ``Skill`` without ``scope`` must raise ValidationError.

    Contract test for the "scope 改必填" decision: the default value was
    removed so that every construction site is forced to stamp the scope
    explicitly. Without this assertion a future ``scope: SkillScope = "extra"``
    regression would silently ship.
    """
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        Skill(  # type: ignore[call-arg]
            name="x",
            description="x",
            type="standard",
            dir=KaosPath.unsafe_from_local_path(tmp_path),
            skill_md_file=KaosPath.unsafe_from_local_path(tmp_path / "SKILL.md"),
            flow=None,
        )


@pytest.mark.asyncio
async def test_discover_flat_md_frontmatter_name_differs_from_filename(tmp_path):
    """For a flat skill, a ``name:`` in frontmatter wins over the filename stem.

    Covers the ``frontmatter.get("name") or default_name`` branch of
    ``parse_skill_text`` for the flat form.
    """
    root = tmp_path / "skills"
    root.mkdir()
    (root / "filename-stem.md").write_text(
        "---\nname: real-name\ndescription: ok\n---\nBody",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    assert len(skills) == 1
    assert skills[0].name == "real-name"
    # Stem is NOT used when frontmatter provides an explicit name.
    assert skills[0].name != "filename-stem"


@pytest.mark.asyncio
async def test_extra_skill_dirs_dedup_with_auto_discovery_overlap(monkeypatch, tmp_path):
    """An ``extra_skill_dirs`` entry that points at an auto-discovered user
    dir does not create a duplicate root.

    Scenario: user puts ``~/.kimi/skills`` (already auto-discovered as the
    user-scope brand root) into ``extra_skill_dirs`` as well. The canonicalize
    dedup must collapse this to a single root, preserving the original
    (user-scope) label rather than duplicating under ``extra``.
    """
    home_dir = tmp_path / "home"
    user_brand = home_dir / ".kimi" / "skills"
    user_brand.mkdir(parents=True)
    _write_skill(
        user_brand / "foo",
        "---\nname: foo\ndescription: user version\n---\n",
    )
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skill_dirs=[str(user_brand)],
    )
    user_brand_kp = KaosPath.unsafe_from_local_path(user_brand.resolve())

    # The same underlying path appears exactly once across the whole root list.
    matching = [s for s in scoped if s.root == user_brand_kp]
    assert len(matching) == 1
    # And it kept the higher-priority scope it was first registered under
    # (user), not the later extra.
    assert matching[0].scope == "user"


@pytest.mark.asyncio
async def test_cli_skills_dir_wins_over_extra_skill_dirs_same_name(monkeypatch, tmp_path):
    """When both ``--skills-dir`` and ``extra_skill_dirs`` define ``foo``, the
    CLI version wins.

    ``resolve_skills_roots`` appends CLI dirs before config-extra, and
    ``setdefault`` keeps the first occurrence — so CLI beats extra for
    same-name conflicts. Lock this so a future reorder cannot silently flip
    the winner.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty_home")
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    cli_dir = tmp_path / "cli"
    cli_dir.mkdir()
    _write_skill(
        cli_dir / "foo",
        "---\nname: foo\ndescription: cli version\n---\n",
    )

    extra_dir = tmp_path / "extra"
    extra_dir.mkdir()
    _write_skill(
        extra_dir / "foo",
        "---\nname: foo\ndescription: extra version\n---\n",
    )

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        skills_dirs=[KaosPath.unsafe_from_local_path(cli_dir)],
        extra_skill_dirs=[str(extra_dir)],
    )
    skills = await discover_skills_from_roots(scoped)
    foos = [s for s in skills if s.name == "foo"]

    assert len(foos) == 1
    assert foos[0].description == "cli version"


# ---------------------------------------------------------------------------
# Commit 1 (A): walk up to the .git project root for project-scope discovery
# ---------------------------------------------------------------------------
#
# Before this change, ``find_project_skills_dirs`` only looked directly under
# the work directory. Launching kimi-cli from a subdirectory of a monorepo
# therefore missed skills defined at the repository root. These tests lock in
# the new behaviour: walk up to the nearest ``.git`` ancestor (fallback to the
# work directory when no marker is found).


@pytest.mark.asyncio
async def test_find_project_skills_dirs_walks_up_to_git_root(tmp_path):
    """Project-scope discovery starts at the nearest ``.git`` ancestor.

    Launching from a nested subdirectory of a repo must still surface skills
    defined at the repo root — otherwise running kimi-cli inside a monorepo
    package silently loses all project-level skills.
    """
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    repo_claude_skills = repo / ".claude" / "skills"
    repo_claude_skills.mkdir(parents=True)
    _write_skill(
        repo_claude_skills / "foo",
        "---\nname: foo\ndescription: repo-root foo\n---\n",
    )

    # Work dir is three levels deep inside the repo.
    nested = repo / "packages" / "sub" / "pkg"
    nested.mkdir(parents=True)

    dirs = await find_project_skills_dirs(KaosPath.unsafe_from_local_path(nested))

    # The repo-root .claude/skills is discovered, not some phantom dir under
    # the nested work dir.
    assert dirs == [KaosPath.unsafe_from_local_path(repo_claude_skills)]


@pytest.mark.asyncio
async def test_find_project_skills_dirs_without_git_falls_back_to_work_dir(tmp_path):
    """With no ``.git`` marker anywhere up the chain, discovery stays at the work dir.

    Lock down that we do NOT keep walking up into the user's ``$HOME`` or
    filesystem root when the tree isn't a git repo — that would surface
    unrelated ``.claude/skills`` from parent directories.
    """
    project = tmp_path / "project"
    (project / ".claude" / "skills").mkdir(parents=True)
    # Nested work dir has no skills and no .git marker.
    work_dir = project / "foo"
    work_dir.mkdir()

    dirs = await find_project_skills_dirs(KaosPath.unsafe_from_local_path(work_dir))

    # The candidate scanned is <work_dir>/.claude/skills (not <project>/...);
    # since <work_dir>/.claude/skills doesn't exist, nothing is returned.
    assert dirs == []


@pytest.mark.asyncio
async def test_find_project_skills_dirs_cwd_is_project_root_still_works(tmp_path):
    """Regression: when the work dir already *is* the project root, behaviour
    is unchanged (no-op walk-up).
    """
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    claude_skills = repo / ".claude" / "skills"
    claude_skills.mkdir(parents=True)
    _write_skill(
        claude_skills / "foo",
        "---\nname: foo\ndescription: root foo\n---\n",
    )

    dirs = await find_project_skills_dirs(KaosPath.unsafe_from_local_path(repo))

    assert dirs == [KaosPath.unsafe_from_local_path(claude_skills)]


# ---------------------------------------------------------------------------
# Commit 2 (B): Config.merge_all_available_skills defaults to True
# ---------------------------------------------------------------------------
#
# Users with skills in more than one brand directory (for example both
# ~/.kimi/skills and ~/.claude/skills after migrating from Claude Code)
# previously lost visibility of everything in .claude/skills because the
# default "first brand wins" behaviour would stop at .kimi/skills. Flipping
# the Config default to True merges all existing brand dirs out of the box.
# The two tests below lock both ends of that contract:
#   (A) the Config value itself is True by default;
#   (B) feeding Config()'s default into resolve_skills_roots actually
#       surfaces every brand directory in the result.


def test_config_default_merges_all_brand_skills():
    """Default Config has merge_all_available_skills=True.

    Lock the Config contract in isolation so a future regression that
    silently flips the default back to False shows up as an obvious red
    test, independent of the wiring inside Runtime.create.
    """
    from kimi_cli.config import Config

    assert Config().merge_all_available_skills is True


@pytest.mark.asyncio
async def test_default_config_effectively_merges_user_brand_skill_dirs(monkeypatch, tmp_path):
    """Default Config → resolve_skills_roots → both brand dirs appear.

    End-to-end companion to the Config-contract test above: threads the
    default Config value through the same bridge ``Runtime.create`` uses
    (``merge_brands=config.merge_all_available_skills``) and asserts that
    both ``~/.kimi/skills`` and ``~/.claude/skills`` are surfaced. If the
    default is ever silently reverted, OR if the merge pipeline breaks for
    ``merge_brands=True``, this test catches it.
    """
    from kimi_cli.config import Config

    home_dir = tmp_path / "home"
    kimi_dir = home_dir / ".kimi" / "skills"
    kimi_dir.mkdir(parents=True)
    claude_dir = home_dir / ".claude" / "skills"
    claude_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    work_dir = tmp_path / "project"
    work_dir.mkdir()

    # Simulate the single production bridge line in Runtime.create.
    config = Config()
    scoped = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        merge_brands=config.merge_all_available_skills,
    )
    roots = [s.root for s in scoped]

    assert KaosPath.unsafe_from_local_path(kimi_dir) in roots
    assert KaosPath.unsafe_from_local_path(claude_dir) in roots


# ---------------------------------------------------------------------------
# Review follow-up: malformed frontmatter opener must not become description
# ---------------------------------------------------------------------------
#
# If a skill file starts with `---` but never closes the YAML block, both
# `parse_frontmatter` (returns None) and `strip_frontmatter` (leaves content
# unchanged) give up — and the body-fallback path used to pick the first
# non-empty line, which is the stray opener itself. The tests below lock the
# fix: standalone `---` delimiter lines are skipped during fallback.


@pytest.mark.asyncio
async def test_discover_flat_md_malformed_frontmatter_opener_not_used_as_description(
    tmp_path,
):
    """A flat .md skill starting with a stray ``---`` line (no closing delimiter)
    does not end up with ``"---"`` as its description.
    """
    root = tmp_path / "skills"
    root.mkdir()
    # Malformed: opener ``---`` is there but never closes.
    (root / "demo.md").write_text(
        "---\n# Hello\nBody text.\n",
        encoding="utf-8",
    )

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    assert len(skills) == 1
    assert skills[0].description != "---"
    assert skills[0].description == "# Hello"


@pytest.mark.asyncio
async def test_discover_subdir_skill_malformed_frontmatter_opener_not_used_as_description(
    tmp_path,
):
    """Same guarantee for subdirectory-form skills: a malformed frontmatter
    opener in SKILL.md must not bleed through as the description.
    """
    root = tmp_path / "skills"
    root.mkdir()
    _write_skill(root / "demo", "---\n# Heading\nBody.\n")

    skills = await discover_skills(KaosPath.unsafe_from_local_path(root), scope="user")
    assert len(skills) == 1
    assert skills[0].description != "---"
    assert skills[0].description == "# Heading"
