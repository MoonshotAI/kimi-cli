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


def test_discover_skills_with_malformed_yaml():
    """Test discovering a skill with malformed YAML syntax."""
    with TemporaryDirectory() as tmpdir:
        skill_dir = Path(tmpdir) / "malformed-yaml-skill"
        skill_dir.mkdir()
        # Use YAML with unclosed string or invalid syntax that causes YAMLError
        (skill_dir / "SKILL.md").write_text(
            """---
name: "unclosed string
description: Missing closing quote
---
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        assert skills == []


def test_discover_skills_with_non_string_types():
    """Test discovering skills with non-string name/description types."""
    with TemporaryDirectory() as tmpdir:
        # Skill with numeric name
        skill_dir1 = Path(tmpdir) / "numeric-name-skill"
        skill_dir1.mkdir()
        (skill_dir1 / "SKILL.md").write_text(
            """---
name: 123
description: Valid description
---
""",
            encoding="utf-8",
        )

        # Skill with boolean name
        skill_dir2 = Path(tmpdir) / "boolean-name-skill"
        skill_dir2.mkdir()
        (skill_dir2 / "SKILL.md").write_text(
            """---
name: true
description: Valid description
---
""",
            encoding="utf-8",
        )

        # Skill with list name
        skill_dir3 = Path(tmpdir) / "list-name-skill"
        skill_dir3.mkdir()
        (skill_dir3 / "SKILL.md").write_text(
            """---
name: [item1, item2]
description: Valid description
---
""",
            encoding="utf-8",
        )

        # Skill with numeric description
        skill_dir4 = Path(tmpdir) / "numeric-desc-skill"
        skill_dir4.mkdir()
        (skill_dir4 / "SKILL.md").write_text(
            """---
name: valid-name
description: 456
---
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        assert skills == []


def test_discover_skills_with_whitespace_only():
    """Test discovering skills with whitespace-only name/description."""
    with TemporaryDirectory() as tmpdir:
        # Skill with whitespace-only name
        skill_dir1 = Path(tmpdir) / "whitespace-name-skill"
        skill_dir1.mkdir()
        (skill_dir1 / "SKILL.md").write_text(
            """---
name: "   "
description: Valid description
---
""",
            encoding="utf-8",
        )

        # Skill with whitespace-only description
        skill_dir2 = Path(tmpdir) / "whitespace-desc-skill"
        skill_dir2.mkdir()
        (skill_dir2 / "SKILL.md").write_text(
            """---
name: valid-name
description: "  \t  "
---
""",
            encoding="utf-8",
        )

        # Skill with both whitespace-only
        skill_dir3 = Path(tmpdir) / "whitespace-both-skill"
        skill_dir3.mkdir()
        (skill_dir3 / "SKILL.md").write_text(
            """---
name: " "
description: "\n\t"
---
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        assert skills == []


def test_format_skills_preserves_markdown():
    """Test that markdown special characters are preserved in formatted output."""
    with TemporaryDirectory() as tmpdir:
        skill_dir = Path(tmpdir) / "test-skill"
        skill_dir.mkdir()
        skill_md = skill_dir / "SKILL.md"

        skills = [
            SkillInfo(
                name="skill*with*markdown",
                description="Description with `code` and **bold**",
                path=skill_dir,
                skill_md_path=skill_md,
            )
        ]

        formatted = format_skills_for_prompt(skills)
        # Verify markdown characters are preserved (not escaped) since this is for LLM consumption
        assert "skill*with*markdown" in formatted
        assert "Description with `code`" in formatted
        assert "**bold**" in formatted


def test_discover_skills_frontmatter_parsing_edge_case():
    """Test frontmatter parsing with edge case of file starting with 4 dashes."""
    with TemporaryDirectory() as tmpdir:
        # File starting with "----" (4 dashes) - the old bug would find closing
        # delimiter at position 3, resulting in empty frontmatter. With the fix,
        # it should search from position 4 and not find a valid closing delimiter.
        skill_dir = Path(tmpdir) / "four-dashes-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            """----
""",
            encoding="utf-8",
        )

        skills = discover_skills(Path(tmpdir))
        # Should not find valid frontmatter (no closing "---" after position 4)
        assert skills == []
