"""YAML frontmatter parsing for SKILL.md files."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, cast

import yaml

from kimi_cli.exception import KimiCLIException

from .models import SkillMetadata


class SkillParseError(KimiCLIException, ValueError):
    """Raised when SKILL.md cannot be parsed."""

    pass


class SkillValidationError(KimiCLIException, ValueError):
    """Raised when SKILL.md fails validation."""

    pass


def find_skill_md(skill_dir: Path) -> Path | None:
    """Find the SKILL.md file in a skill directory.

    Prefers SKILL.md (uppercase) but accepts skill.md (lowercase).

    Args:
        skill_dir: Path to the skill directory

    Returns:
        Path to the SKILL.md file, or None if not found
    """
    for name in ("SKILL.md", "skill.md"):
        path = skill_dir / name
        if path.exists():
            return path
    return None


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter from SKILL.md content.

    Args:
        content: Raw content of SKILL.md file

    Returns:
        Tuple of (metadata dict, markdown body)

    Raises:
        SkillParseError: If frontmatter is missing or invalid
    """
    if not content.startswith("---"):
        raise SkillParseError("SKILL.md must start with YAML frontmatter (---)")

    parts = content.split("---", 2)
    if len(parts) < 3:
        raise SkillParseError("SKILL.md frontmatter not properly closed with ---")

    frontmatter_str = parts[1]
    body = parts[2].strip()

    try:
        raw_metadata: Any = yaml.safe_load(frontmatter_str)
    except yaml.YAMLError as e:
        raise SkillParseError(f"Invalid YAML in frontmatter: {e}") from e

    if not isinstance(raw_metadata, dict):
        raise SkillParseError("SKILL.md frontmatter must be a YAML mapping")

    # Cast to proper type after validation - raw_metadata is dict[Any, Any] from yaml
    metadata = cast(dict[str, Any], raw_metadata)
    return metadata, body


def read_skill_metadata(skill_dir: Path) -> SkillMetadata:
    """Read skill metadata from SKILL.md frontmatter.

    Args:
        skill_dir: Path to the skill directory

    Returns:
        SkillMetadata with parsed data

    Raises:
        SkillParseError: If SKILL.md is missing or has invalid YAML
        SkillValidationError: If required fields are missing or invalid
    """
    skill_md = find_skill_md(skill_dir)
    if skill_md is None:
        raise SkillParseError(f"SKILL.md not found in {skill_dir}")

    content = skill_md.read_text(encoding="utf-8")
    metadata, _ = parse_frontmatter(content)

    # Validate required fields
    if "name" not in metadata:
        raise SkillValidationError("Missing required field in frontmatter: name")
    if "description" not in metadata:
        raise SkillValidationError("Missing required field in frontmatter: description")

    # Validate name format
    name = metadata["name"]
    if not is_valid_skill_name(name):
        raise SkillValidationError(
            f"Invalid skill name '{name}': must be lowercase letters, "
            "numbers, and hyphens, 1-64 characters, not starting/ending with hyphen"
        )

    # Validate description length
    description = metadata["description"]
    if len(description) > 1024:
        raise SkillValidationError("Description exceeds 1024 character limit")

    # Parse triggers list
    triggers_raw: object = metadata.get("triggers", [])
    triggers: list[str] = []
    if isinstance(triggers_raw, list):
        triggers_list = cast(list[Any], triggers_raw)
        for item in triggers_list:
            if item:
                triggers.append(str(item))

    return SkillMetadata(
        name=name,
        description=description,
        path=skill_dir,
        license=metadata.get("license"),
        triggers=triggers,
        metadata=metadata.get("metadata", {}),
    )


def is_valid_skill_name(name: str) -> bool:
    """Validate skill name format.

    Valid names:
    - 1-64 characters
    - Lowercase letters, numbers, and hyphens only
    - Cannot start or end with hyphen
    """
    if len(name) < 1 or len(name) > 64:
        return False
    return bool(re.match(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", name))
