"""Data models for the skills system."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class SkillMetadata(BaseModel):
    """Lightweight skill metadata loaded at startup.

    This contains only the frontmatter data from SKILL.md, minimizing
    context overhead during skill discovery.
    """

    name: str = Field(description="Skill name (lowercase, hyphens, max 64 chars)")
    description: str = Field(description="Brief description of what the skill does")
    path: Path = Field(description="Path to the skill directory")
    license: str | None = Field(default=None, description="License name or reference")
    triggers: list[str] = Field(
        default_factory=list,
        description="Keywords/phrases that should trigger this skill",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict, description="Arbitrary key-value pairs (author, version, etc.)"
    )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "description": self.description,
            "path": str(self.path),
            "license": self.license,
            "triggers": self.triggers,
            "metadata": self.metadata,
        }


class Skill(BaseModel):
    """Full skill with instructions loaded.

    This is used when a skill is activated and the full SKILL.md
    content needs to be injected into context.
    """

    metadata: SkillMetadata = Field(description="Skill metadata from frontmatter")
    instructions: str = Field(description="Full markdown body with instructions")

    @property
    def name(self) -> str:
        """Get skill name."""
        return self.metadata.name

    @property
    def description(self) -> str:
        """Get skill description."""
        return self.metadata.description

    @property
    def path(self) -> Path:
        """Get skill directory path."""
        return self.metadata.path
