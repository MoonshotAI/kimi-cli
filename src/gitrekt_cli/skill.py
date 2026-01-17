"""Skill specification discovery and loading utilities."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from loguru import logger
from pydantic import BaseModel, ConfigDict

from gitrekt_cli.share import get_share_dir
from gitrekt_cli.utils.frontmatter import read_frontmatter


def get_skills_dir() -> Path:
    """
    Get the default skills directory path.
    """
    return get_share_dir() / "skills"


def get_builtin_skills_dir() -> Path:
    """
    Get the built-in skills directory path.
    """
    return Path(__file__).parent / "skills"


def get_claude_skills_dir() -> Path:
    """
    Get the default skills directory path of Claude.
    """
    return Path.home() / ".claude" / "skills"


def normalize_skill_name(name: str) -> str:
    """Normalize a skill name for lookup."""
    return name.casefold()


def index_skills(skills: Iterable[Skill]) -> dict[str, Skill]:
    """Build a lookup table for skills by normalized name."""
    return {normalize_skill_name(skill.name): skill for skill in skills}


def discover_skills_from_roots(skills_dirs: Iterable[Path]) -> list[Skill]:
    """
    Discover skills from multiple directory roots.
    """
    skills_by_name: dict[str, Skill] = {}
    for skills_dir in skills_dirs:
        for skill in discover_skills(skills_dir):
            skills_by_name[normalize_skill_name(skill.name)] = skill
    return sorted(skills_by_name.values(), key=lambda s: s.name)


def read_skill_text(skill: Skill) -> str | None:
    """Read the SKILL.md contents for a skill."""
    try:
        return skill.skill_md_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        logger.warning(
            "Failed to read skill file {path}: {error}",
            path=skill.skill_md_file,
            error=exc,
        )
        return None


class Skill(BaseModel):
    """Information about a single skill."""

    model_config = ConfigDict(extra="ignore")

    name: str
    description: str
    dir: Path

    @property
    def skill_md_file(self) -> Path:
        """Path to the SKILL.md file."""
        return self.dir / "SKILL.md"


def discover_skills(skills_dir: Path) -> list[Skill]:
    """
    Discover all skills in the given directory.

    Args:
        skills_dir: Path to the directory containing skills.

    Returns:
        List of Skill objects, one for each valid skill found.
    """
    if not skills_dir.is_dir():
        return []

    skills: list[Skill] = []

    # Iterate through all subdirectories in the skills directory
    for skill_dir in skills_dir.iterdir():
        if not skill_dir.is_dir():
            continue

        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            continue

        # Try to parse the SKILL.md file
        try:
            skills.append(parse_skill_md(skill_md))
        except Exception as e:
            # Skip invalid skills, but log for debugging
            logger.info("Skipping invalid skill at {}: {}", skill_md, e)
            continue

    return sorted(skills, key=lambda s: s.name)


def parse_skill_md(skill_md_file: Path) -> Skill:
    """
    Parse a SKILL.md file to extract name and description.

    Args:
        skill_md_file: Path to the SKILL.md file.

    Returns:
        Skill object.

    Raises:
        ValueError: If the SKILL.md file is not valid.
    """
    frontmatter = read_frontmatter(skill_md_file) or {}

    if "name" not in frontmatter:
        frontmatter["name"] = skill_md_file.parent.name
    if "description" not in frontmatter:
        frontmatter["description"] = "No description provided."

    return Skill.model_validate(
        {
            **frontmatter,
            "dir": skill_md_file.parent.absolute(),
        }
    )
