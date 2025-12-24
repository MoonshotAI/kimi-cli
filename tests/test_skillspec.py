"""Tests for skill specification discovery and loading."""

from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from kimi_cli.skillspec import SkillInfo, discover_skills, format_skills_for_prompt


def test_discover_skills_empty_folder():
    """Test discovering skills from an empty folder."""
    with TemporaryDirectory() as tmpdir:
        skills = discover_skills(Path(tmpdir))
        assert skills == []


def test_discover_skills_nonexistent_folder():
    """Test discovering skills from a nonexistent folder."""
    skills = discover_skills(Path("/nonexistent/folder"))
    assert skills == []


def test_discover_skills_with_valid_skill():
    """Test discovering a valid skill."""
    with TemporaryDirectory() as tmpdir:
        skill_dir = Path(tmpdir) / "test-skill"
        skill_dir.mkdir()

        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text(
            """---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill.
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        assert len(skills) == 1
        assert skills[0].name == "test-skill"
        assert skills[0].description == "A test skill for unit testing"
        assert skills[0].path == skill_dir.resolve()
        assert skills[0].skill_md_path == skill_md.resolve()


def test_discover_skills_with_invalid_skill():
    """Test discovering a skill with invalid SKILL.md."""
    with TemporaryDirectory() as tmpdir:
        # Skill without frontmatter
        skill_dir1 = Path(tmpdir) / "invalid-skill-1"
        skill_dir1.mkdir()
        (skill_dir1 / "SKILL.md").write_text("# No frontmatter", encoding="utf-8")

        # Skill without name
        skill_dir2 = Path(tmpdir) / "invalid-skill-2"
        skill_dir2.mkdir()
        (skill_dir2 / "SKILL.md").write_text(
            """---
description: Missing name
---
""",
            encoding="utf-8",
        )

        # Skill without description
        skill_dir3 = Path(tmpdir) / "invalid-skill-3"
        skill_dir3.mkdir()
        (skill_dir3 / "SKILL.md").write_text(
            """---
name: missing-description
---
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        assert skills == []


def test_discover_skills_with_multiple_skills():
    """Test discovering multiple skills."""
    with TemporaryDirectory() as tmpdir:
        # Create first skill
        skill_dir1 = Path(tmpdir) / "skill-alpha"
        skill_dir1.mkdir()
        (skill_dir1 / "SKILL.md").write_text(
            """---
name: skill-alpha
description: First skill
---
""",
            encoding="utf-8",
        )

        # Create second skill
        skill_dir2 = Path(tmpdir) / "skill-beta"
        skill_dir2.mkdir()
        (skill_dir2 / "SKILL.md").write_text(
            """---
name: skill-beta
description: Second skill
---
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        assert len(skills) == 2
        # Skills should be sorted by name
        assert skills[0].name == "skill-alpha"
        assert skills[1].name == "skill-beta"


def test_format_skills_for_prompt_empty():
    """Test formatting an empty skills list."""
    formatted = format_skills_for_prompt([])
    assert "No skills available" in formatted


def test_format_skills_for_prompt_with_skills():
    """Test formatting skills for prompt."""
    with TemporaryDirectory() as tmpdir:
        skill_dir = Path(tmpdir) / "test-skill"
        skill_dir.mkdir()
        skill_md = skill_dir / "SKILL.md"

        skills = [
            SkillInfo(
                name="test-skill",
                description="A test skill",
                path=skill_dir,
                skill_md_path=skill_md,
            )
        ]

        formatted = format_skills_for_prompt(skills)
        assert "test-skill" in formatted
        assert "A test skill" in formatted
        assert str(skill_md) in formatted


def test_discover_skills_ignores_files():
    """Test that skill discovery ignores files in the skill folder."""
    with TemporaryDirectory() as tmpdir:
        # Create a file (should be ignored)
        (Path(tmpdir) / "not-a-skill.md").write_text("Not a skill", encoding="utf-8")

        # Create a directory without SKILL.md (should be ignored)
        no_skill_dir = Path(tmpdir) / "no-skill"
        no_skill_dir.mkdir()

        skills = discover_skills(Path(tmpdir))
        assert skills == []


def test_skill_info_is_immutable():
    """Test that SkillInfo is immutable."""
    with TemporaryDirectory() as tmpdir:
        skill_dir = Path(tmpdir)
        skill_md = skill_dir / "SKILL.md"

        skill_info = SkillInfo(
            name="test",
            description="Test",
            path=skill_dir,
            skill_md_path=skill_md,
        )

        with pytest.raises(AttributeError):
            skill_info.name = "new-name"  # type: ignore[misc]
