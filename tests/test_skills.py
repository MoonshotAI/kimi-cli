"""Tests for the skills system."""

from __future__ import annotations

from pathlib import Path

import pytest

from kimi_cli.skills import (
    Skill,
    SkillMetadata,
    SkillParseError,
    SkillsLoader,
    SkillValidationError,
    format_activated_skill,
    format_skill_info,
    format_skills_list,
    generate_skills_system_prompt,
    validate_skill,
    validate_skill_security,
)
from kimi_cli.skills.parser import (
    find_skill_md,
    is_valid_skill_name,
    parse_frontmatter,
    read_skill_metadata,
)


class TestSkillMetadata:
    def test_create_skill_metadata(self, tmp_path: Path):
        metadata = SkillMetadata(
            name="test-skill",
            description="A test skill",
            path=tmp_path,
            license="MIT",
            metadata={"author": "test", "version": "1.0"},
        )
        assert metadata.name == "test-skill"
        assert metadata.description == "A test skill"
        assert metadata.path == tmp_path
        assert metadata.license == "MIT"
        assert metadata.metadata == {"author": "test", "version": "1.0"}

    def test_to_dict(self, tmp_path: Path):
        metadata = SkillMetadata(
            name="test-skill",
            description="A test skill",
            path=tmp_path,
        )
        result = metadata.to_dict()
        assert result["name"] == "test-skill"
        assert result["description"] == "A test skill"
        assert result["path"] == str(tmp_path)


class TestSkill:
    def test_create_skill(self, tmp_path: Path):
        metadata = SkillMetadata(
            name="test-skill",
            description="A test skill",
            path=tmp_path,
        )
        skill = Skill(
            metadata=metadata,
            instructions="# Test Skill\n\nDo something.",
        )
        assert skill.name == "test-skill"
        assert skill.description == "A test skill"
        assert skill.path == tmp_path
        assert "Do something" in skill.instructions


class TestParseFrontmatter:
    def test_valid_frontmatter(self):
        content = """---
name: my-skill
description: A test skill
---
# My Skill

Instructions here.
"""
        metadata, body = parse_frontmatter(content)
        assert metadata["name"] == "my-skill"
        assert metadata["description"] == "A test skill"
        assert "# My Skill" in body
        assert "Instructions here" in body

    def test_frontmatter_with_metadata(self):
        content = """---
name: my-skill
description: A test skill
license: MIT
metadata:
  author: test
  version: "1.0"
---
Body here.
"""
        metadata, body = parse_frontmatter(content)
        assert metadata["name"] == "my-skill"
        assert metadata["license"] == "MIT"
        assert metadata["metadata"]["author"] == "test"
        assert body == "Body here."

    def test_missing_frontmatter(self):
        content = "# No frontmatter here"
        with pytest.raises(SkillParseError, match="must start with YAML frontmatter"):
            parse_frontmatter(content)

    def test_unclosed_frontmatter(self):
        content = """---
name: my-skill
description: A test skill
"""
        with pytest.raises(SkillParseError, match="not properly closed"):
            parse_frontmatter(content)

    def test_invalid_yaml(self):
        content = """---
name: my-skill
description: [invalid: yaml
---
Body
"""
        with pytest.raises(SkillParseError, match="Invalid YAML"):
            parse_frontmatter(content)

    def test_non_dict_frontmatter(self):
        content = """---
- item1
- item2
---
Body
"""
        with pytest.raises(SkillParseError, match="must be a YAML mapping"):
            parse_frontmatter(content)


class TestIsValidName:
    def test_valid_names(self):
        assert is_valid_skill_name("my-skill") is True
        assert is_valid_skill_name("skill1") is True
        assert is_valid_skill_name("a") is True
        assert is_valid_skill_name("my-cool-skill-123") is True
        assert is_valid_skill_name("abc123") is True

    def test_invalid_names(self):
        # Uppercase not allowed
        assert is_valid_skill_name("My-Skill") is False
        # Underscores not allowed
        assert is_valid_skill_name("my_skill") is False
        # Cannot start with hyphen
        assert is_valid_skill_name("-skill") is False
        # Cannot end with hyphen
        assert is_valid_skill_name("skill-") is False
        # Too long (over 64 chars)
        assert is_valid_skill_name("a" * 65) is False
        # Empty not allowed
        assert is_valid_skill_name("") is False
        # Spaces not allowed
        assert is_valid_skill_name("my skill") is False


class TestFindSkillMd:
    def test_finds_uppercase(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("content")

        result = find_skill_md(skill_dir)
        assert result is not None
        assert result.name == "SKILL.md"

    def test_finds_lowercase(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "skill.md").write_text("content")

        result = find_skill_md(skill_dir)
        assert result is not None
        assert result.name == "skill.md"

    def test_prefers_uppercase(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("uppercase")
        (skill_dir / "skill.md").write_text("lowercase")

        result = find_skill_md(skill_dir)
        assert result is not None
        assert result.name == "SKILL.md"

    def test_returns_none_when_missing(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()

        result = find_skill_md(skill_dir)
        assert result is None


class TestReadSkillMetadata:
    def test_valid_skill(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: my-skill
description: A test skill
license: MIT
---
# My Skill
""")
        metadata = read_skill_metadata(skill_dir)
        assert metadata.name == "my-skill"
        assert metadata.description == "A test skill"
        assert metadata.license == "MIT"
        assert metadata.path == skill_dir

    def test_missing_name(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
description: A test skill
---
Body
""")
        with pytest.raises(SkillValidationError, match="name"):
            read_skill_metadata(skill_dir)

    def test_missing_description(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: my-skill
---
Body
""")
        with pytest.raises(SkillValidationError, match="description"):
            read_skill_metadata(skill_dir)

    def test_invalid_name_format(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: My_Invalid_Skill
description: A test skill
---
Body
""")
        with pytest.raises(SkillValidationError, match="Invalid skill name"):
            read_skill_metadata(skill_dir)

    def test_description_too_long(self, tmp_path: Path):
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        long_desc = "x" * 1025
        (skill_dir / "SKILL.md").write_text(f"""---
name: my-skill
description: {long_desc}
---
Body
""")
        with pytest.raises(SkillValidationError, match="1024 character"):
            read_skill_metadata(skill_dir)


class TestSkillsLoader:
    def test_discovers_valid_skills(self, tmp_path: Path):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        # Create a valid skill
        valid_skill = skills_dir / "valid-skill"
        valid_skill.mkdir()
        (valid_skill / "SKILL.md").write_text("""---
name: valid-skill
description: A valid test skill
---
# Valid Skill
Instructions here.
""")

        loader = SkillsLoader(additional_dirs=[skills_dir])
        skills = loader.discover_skills()

        names = [s.name for s in skills]
        assert "valid-skill" in names

    def test_skips_invalid_skills(self, tmp_path: Path):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        # Create an invalid skill (missing description)
        invalid_skill = skills_dir / "invalid-skill"
        invalid_skill.mkdir()
        (invalid_skill / "SKILL.md").write_text("""---
name: invalid-skill
---
Missing description.
""")

        loader = SkillsLoader(additional_dirs=[skills_dir])
        skills = loader.discover_skills()

        names = [s.name for s in skills]
        assert "invalid-skill" not in names

    def test_skips_disabled_skills(self, tmp_path: Path):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        # Create a valid skill
        skill = skills_dir / "disabled-skill"
        skill.mkdir()
        (skill / "SKILL.md").write_text("""---
name: disabled-skill
description: A disabled skill
---
Body
""")

        loader = SkillsLoader(
            additional_dirs=[skills_dir],
            disabled_skills=["disabled-skill"],
        )
        skills = loader.discover_skills()

        names = [s.name for s in skills]
        assert "disabled-skill" not in names

    def test_loads_full_skill(self, tmp_path: Path):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        skill_dir = skills_dir / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: my-skill
description: A test skill
---
# My Skill

## Instructions

Do something specific.
""")

        loader = SkillsLoader(additional_dirs=[skills_dir])
        loader.discover_skills()

        skill = loader.load_full_skill("my-skill")
        assert skill is not None
        assert skill.name == "my-skill"
        assert "Do something specific" in skill.instructions

    def test_returns_none_for_missing_skill(self, tmp_path: Path):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        loader = SkillsLoader(additional_dirs=[skills_dir])
        loader.discover_skills()

        skill = loader.load_full_skill("nonexistent")
        assert skill is None

    def test_handles_duplicate_skills(self, tmp_path: Path):
        # Create two skills directories with same skill name
        dir1 = tmp_path / "dir1"
        dir1.mkdir()
        skill1 = dir1 / "dupe-skill"
        skill1.mkdir()
        (skill1 / "SKILL.md").write_text("""---
name: dupe-skill
description: First one
---
First
""")

        dir2 = tmp_path / "dir2"
        dir2.mkdir()
        skill2 = dir2 / "dupe-skill"
        skill2.mkdir()
        (skill2 / "SKILL.md").write_text("""---
name: dupe-skill
description: Second one
---
Second
""")

        # First dir should take priority
        loader = SkillsLoader(additional_dirs=[dir1, dir2])
        skills = loader.discover_skills()

        assert len([s for s in skills if s.name == "dupe-skill"]) == 1
        skill = loader.load_full_skill("dupe-skill")
        assert skill is not None
        assert "First" in skill.instructions

    def test_refresh_clears_cache(self, tmp_path: Path):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        loader = SkillsLoader(additional_dirs=[skills_dir], use_default_dirs=False)
        skills = loader.discover_skills()
        assert len(skills) == 0

        # Add a skill
        skill_dir = skills_dir / "new-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: new-skill
description: A new skill
---
New skill body
""")

        # Refresh should find it
        skills = loader.refresh()
        assert len(skills) == 1
        assert skills[0].name == "new-skill"


class TestValidateSkill:
    def test_valid_skill(self, tmp_path: Path):
        skill_dir = tmp_path / "valid-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: valid-skill
description: A valid skill
---
# Valid Skill

Instructions here.
""")
        errors = validate_skill(skill_dir)
        assert errors == []

    def test_missing_directory(self, tmp_path: Path):
        nonexistent = tmp_path / "nonexistent"
        errors = validate_skill(nonexistent)
        assert len(errors) == 1
        assert "does not exist" in errors[0]

    def test_not_a_directory(self, tmp_path: Path):
        file_path = tmp_path / "file.txt"
        file_path.write_text("not a directory")
        errors = validate_skill(file_path)
        assert len(errors) == 1
        assert "Not a directory" in errors[0]

    def test_missing_skill_md(self, tmp_path: Path):
        skill_dir = tmp_path / "no-skill-md"
        skill_dir.mkdir()
        errors = validate_skill(skill_dir)
        assert len(errors) == 1
        assert "Missing required file" in errors[0]

    def test_empty_body(self, tmp_path: Path):
        skill_dir = tmp_path / "empty-body"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: empty-body
description: Has empty body
---
""")
        errors = validate_skill(skill_dir)
        assert any("body is empty" in e for e in errors)


class TestValidateSkillSecurity:
    def test_warns_on_suspicious_files(self, tmp_path: Path):
        skill_dir = tmp_path / "suspicious"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: suspicious
description: Has suspicious files
---
Body
""")
        (skill_dir / "malware.exe").write_text("bad")

        warnings = validate_skill_security(skill_dir)
        assert any(".exe" in w for w in warnings)

    def test_warns_on_path_traversal(self, tmp_path: Path):
        skill_dir = tmp_path / "traversal"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("""---
name: traversal
description: Has path traversal
---
Load file from ../../../etc/passwd
""")

        warnings = validate_skill_security(skill_dir)
        assert any("path traversal" in w.lower() for w in warnings)


class TestContextHelpers:
    def test_generate_skills_system_prompt_empty(self):
        result = generate_skills_system_prompt([])
        assert result == ""

    def test_generate_skills_system_prompt(self, tmp_path: Path):
        skills = [
            SkillMetadata(name="skill-a", description="Does A", path=tmp_path),
            SkillMetadata(name="skill-b", description="Does B", path=tmp_path),
        ]
        result = generate_skills_system_prompt(skills)

        assert "Available Skills" in result
        assert "skill-a" in result
        assert "Does A" in result
        assert "skill-b" in result
        assert "Does B" in result
        assert "ActivateSkill" in result

    def test_format_skills_list_empty(self):
        result = format_skills_list([])
        assert "No skills found" in result

    def test_format_skills_list(self, tmp_path: Path):
        skills = [
            SkillMetadata(name="my-skill", description="My description", path=tmp_path),
        ]
        result = format_skills_list(skills)

        assert "my-skill" in result
        assert "My description" in result

    def test_format_activated_skill(self, tmp_path: Path):
        metadata = SkillMetadata(name="my-skill", description="Test", path=tmp_path)
        skill = Skill(metadata=metadata, instructions="# Instructions\n\nDo this.")

        result = format_activated_skill(skill)

        assert "Activated Skill: my-skill" in result
        assert "# Instructions" in result
        assert "Do this" in result
        assert str(tmp_path) in result

    def test_format_skill_info(self, tmp_path: Path):
        metadata = SkillMetadata(
            name="my-skill",
            description="Test skill",
            path=tmp_path,
            license="MIT",
            metadata={"author": "test"},
        )
        skill = Skill(metadata=metadata, instructions="# Do stuff")

        result = format_skill_info(skill)

        assert "my-skill" in result
        assert "Test skill" in result
        assert "MIT" in result
        assert "author" in result
        assert "# Do stuff" in result
