"""Tests for skill discovery and formatting behavior."""

from pathlib import Path
from tempfile import TemporaryDirectory

from inline_snapshot import snapshot

from kimi_cli.skill import Skill, discover_skills


def _write_skill(skill_dir: Path, content: str) -> None:
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")


def test_discover_skills_returns_empty_for_missing_or_empty():
    with TemporaryDirectory() as tmpdir:
        skills_dir = Path(tmpdir)
        skills = discover_skills(skills_dir)
        assert skills == snapshot([])

        missing_dir = skills_dir / "missing"
        skills = discover_skills(missing_dir)
        assert skills == snapshot([])


def test_discover_skills_ignores_non_skill_entries():
    with TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "not-a-skill.md").write_text("Not a skill", encoding="utf-8")
        (root / "no-skill").mkdir()

        skills = discover_skills(root)
        assert skills == snapshot([])


def test_discover_skills_parses_frontmatter_and_defaults():
    with TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)

        skill_a = root / "alpha"
        _write_skill(
            skill_a,
            """---
name: alpha-skill
description: Alpha description
---
""",
        )

        skill_b = root / "beta"
        _write_skill(
            skill_b,
            """---
description: Beta description
---
""",
        )

        skill_c = root / "gamma"
        _write_skill(skill_c, "# No frontmatter")

        skills = discover_skills(root)
        for skill in skills:
            skill.dir = Path("/path/to") / (skill.dir.relative_to(tmpdir))
        assert skills == snapshot(
            [
                Skill(
                    name="alpha-skill",
                    description="Alpha description",
                    dir=Path("/path/to/alpha"),
                ),
                Skill(name="beta", description="Beta description", dir=Path("/path/to/beta")),
                Skill(
                    name="gamma",
                    description="No description provided.",
                    dir=Path("/path/to/gamma"),
                ),
            ]
        )
        assert [skill.name for skill in skills] == snapshot(["alpha-skill", "beta", "gamma"])


def test_discover_skills_skips_invalid_frontmatter():
    with TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)

        invalid_yaml = root / "invalid-yaml"
        _write_skill(
            invalid_yaml,
            """---
name: "unterminated
description: oops
---
""",
        )

        invalid_mapping = root / "invalid-mapping"
        _write_skill(
            invalid_mapping,
            """---
- item
---
""",
        )

        valid = root / "valid"
        _write_skill(
            valid,
            """---
name: valid
description: OK
---
""",
        )

        skills = discover_skills(root)
        for skill in skills:
            skill.dir = Path("/path/to") / (skill.dir.relative_to(tmpdir))
        assert skills == snapshot(
            [Skill(name="valid", description="OK", dir=Path("/path/to/valid"))]
        )
