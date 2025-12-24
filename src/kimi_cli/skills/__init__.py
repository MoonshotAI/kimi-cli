"""Skills system for Kimi CLI.

This module implements a skills system that allows users to define custom,
reusable agent capabilities as markdown files following the Agent Skills
open specification format.
"""

from __future__ import annotations

from kimi_cli.skills.context import (
    format_activated_skill,
    format_skill_info,
    format_skills_list,
    generate_skills_system_prompt,
)
from kimi_cli.skills.loader import SkillsLoader
from kimi_cli.skills.models import Skill, SkillMetadata
from kimi_cli.skills.parser import SkillParseError, SkillValidationError
from kimi_cli.skills.tools import ActivateSkill, ListSkills, SkillInfo, ValidateSkill
from kimi_cli.skills.validator import validate_skill, validate_skill_security

__all__ = [
    # Models
    "Skill",
    "SkillMetadata",
    # Loader
    "SkillsLoader",
    # Parser exceptions
    "SkillParseError",
    "SkillValidationError",
    # Context helpers
    "generate_skills_system_prompt",
    "format_activated_skill",
    "format_skill_info",
    "format_skills_list",
    # Validator
    "validate_skill",
    "validate_skill_security",
    # Tools
    "ActivateSkill",
    "ListSkills",
    "SkillInfo",
    "ValidateSkill",
]
