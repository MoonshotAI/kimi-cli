"""Skill specification discovery and loading utilities."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import yaml


@dataclass(frozen=True)
class SkillInfo:
    """Information about a single skill."""

    name: str
    description: str
    path: Path
    skill_md_path: Path


def discover_skills(skill_folder: Path) -> list[SkillInfo]:
    """
    Discover all skills in the given folder.

    Args:
        skill_folder: Path to the folder containing skills.

    Returns:
        List of SkillInfo objects, one for each valid skill found.
    """
    if not skill_folder.exists() or not skill_folder.is_dir():
        return []

    skills: list[SkillInfo] = []

    # Iterate through all subdirectories in the skill folder
    for skill_dir in skill_folder.iterdir():
        if not skill_dir.is_dir():
            continue

        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists() or not skill_md.is_file():
            continue

        # Try to parse the SKILL.md file
        try:
            skill_info = _parse_skill_md(skill_md, skill_dir)
            if skill_info:
                skills.append(skill_info)
        except Exception:
            # Skip invalid skills
            continue

    return sorted(skills, key=lambda s: s.name)


def _parse_skill_md(skill_md_path: Path, skill_dir: Path) -> SkillInfo | None:
    """
    Parse a SKILL.md file to extract name and description.

    Args:
        skill_md_path: Path to the SKILL.md file.
        skill_dir: Path to the skill directory.

    Returns:
        SkillInfo object if valid, None otherwise.
    """
    content = skill_md_path.read_text(encoding="utf-8")

    # Extract YAML frontmatter
    if not content.startswith("---"):
        return None

    # Find the end of frontmatter
    end_idx = content.find("---", 3)
    if end_idx == -1:
        return None

    frontmatter = content[3:end_idx].strip()

    try:
        raw_data: Any = yaml.safe_load(frontmatter)
    except yaml.YAMLError:
        return None

    if not isinstance(raw_data, dict):
        return None

    data = cast(dict[str, Any], raw_data)
    name = data.get("name")
    description = data.get("description")

    if not name or not description:
        return None

    if not isinstance(name, str) or not isinstance(description, str):
        return None

    return SkillInfo(
        name=name,
        description=description,
        path=skill_dir.resolve(),
        skill_md_path=skill_md_path.resolve(),
    )


def format_skills_for_prompt(skills: list[SkillInfo]) -> str:
    """
    Format skills information for inclusion in system prompt.

    Args:
        skills: List of SkillInfo objects.

    Returns:
        Formatted string describing all skills.
    """
    if not skills:
        return "No skills available in the skill folder."

    lines: list[str] = []
    for skill in skills:
        lines.append(f"- **{skill.name}**: {skill.description}")
        lines.append(f"  - Path: `{skill.skill_md_path}`")

    return "\n".join(lines)
