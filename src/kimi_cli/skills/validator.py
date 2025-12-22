"""Skill validation utilities."""

from __future__ import annotations

import re
from pathlib import Path

from .parser import SkillParseError, find_skill_md, parse_frontmatter


def validate_skill(skill_dir: Path) -> list[str]:
    """Validate a skill directory.

    Args:
        skill_dir: Path to the skill directory

    Returns:
        List of validation error messages. Empty list means valid.
    """
    errors: list[str] = []
    skill_dir = Path(skill_dir)

    # Check directory exists
    if not skill_dir.exists():
        return [f"Path does not exist: {skill_dir}"]

    if not skill_dir.is_dir():
        return [f"Not a directory: {skill_dir}"]

    # Check SKILL.md exists
    skill_md = find_skill_md(skill_dir)
    if skill_md is None:
        return ["Missing required file: SKILL.md"]

    # Parse and validate frontmatter
    try:
        content = skill_md.read_text(encoding="utf-8")
        metadata, body = parse_frontmatter(content)
    except SkillParseError as e:
        return [str(e)]

    # Validate required fields
    if "name" not in metadata:
        errors.append("Missing required field: name")
    elif not _validate_name(metadata["name"]):
        errors.append(
            f"Invalid name '{metadata['name']}': must be lowercase letters, "
            "numbers, and hyphens, 1-64 characters, not starting/ending with hyphen"
        )

    if "description" not in metadata:
        errors.append("Missing required field: description")
    elif len(metadata["description"]) > 1024:
        errors.append("Description exceeds 1024 character limit")

    # Validate optional fields
    if "license" in metadata and not isinstance(metadata["license"], str):
        errors.append("License must be a string")

    if "metadata" in metadata:
        meta_value = metadata["metadata"]
        if not isinstance(meta_value, dict):
            errors.append("Metadata must be a mapping")
        else:
            meta_dict: dict[str, object] = meta_value  # pyright: ignore[reportUnknownVariableType]
            for k, v in meta_dict.items():
                if not isinstance(v, (str, int, float, bool)):
                    errors.append(f"Invalid metadata entry: {k}")

    # Check body has content
    if not body.strip():
        errors.append("SKILL.md body is empty - add instructions for the agent")

    return errors


def _validate_name(name: str) -> bool:
    """Validate skill name format.

    Valid names:
    - 1-64 characters
    - Lowercase letters, numbers, and hyphens only
    - Cannot start or end with hyphen
    """
    if len(name) < 1 or len(name) > 64:
        return False
    return bool(re.match(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", name))


# Security validation constants
MAX_SKILL_MD_SIZE = 100 * 1024  # 100KB
MAX_SCRIPT_SIZE = 50 * 1024  # 50KB
MAX_TOTAL_SKILL_SIZE = 1024 * 1024  # 1MB

# Suspicious file extensions that warrant warnings
SUSPICIOUS_EXTENSIONS = {".exe", ".dll", ".so", ".dylib", ".bin", ".bat", ".cmd", ".ps1"}


def validate_skill_security(skill_dir: Path) -> list[str]:
    """Perform security validation on a skill.

    Args:
        skill_dir: Path to the skill directory

    Returns:
        List of security warnings/errors
    """
    warnings: list[str] = []
    skill_dir = Path(skill_dir)

    if not skill_dir.exists() or not skill_dir.is_dir():
        return ["Skill directory does not exist"]

    # Check total size
    total_size = sum(f.stat().st_size for f in skill_dir.rglob("*") if f.is_file())
    if total_size > MAX_TOTAL_SKILL_SIZE:
        max_size = MAX_TOTAL_SKILL_SIZE
        warnings.append(f"Skill exceeds size limit: {total_size} bytes (max: {max_size})")

    # Check SKILL.md size
    skill_md = find_skill_md(skill_dir)
    if skill_md and skill_md.stat().st_size > MAX_SKILL_MD_SIZE:
        size = skill_md.stat().st_size
        max_size = MAX_SKILL_MD_SIZE
        warnings.append(f"SKILL.md exceeds size limit: {size} bytes (max: {max_size})")

    # Check for suspicious files
    for f in skill_dir.rglob("*"):
        if f.is_file():
            if f.suffix.lower() in SUSPICIOUS_EXTENSIONS:
                warnings.append(f"Suspicious file type: {f.name}")
            if f.name.startswith("."):
                warnings.append(f"Hidden file found: {f.name}")

    # Check for path traversal attempts in skill content
    if skill_md and skill_md.exists():
        content = skill_md.read_text(encoding="utf-8")
        if "../" in content or "..\\" in content:
            warnings.append("Potential path traversal pattern found in SKILL.md")

    return warnings
