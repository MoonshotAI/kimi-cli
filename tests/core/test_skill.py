"""Tests for skill discovery and formatting behavior."""

from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.skill import (
    Skill,
    discover_skills,
    discover_skills_from_roots,
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
