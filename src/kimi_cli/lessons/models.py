"""Data models for the Lessons system."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class LessonSource(str, Enum):
    """Source of how a lesson was created."""

    ENV_FEEDBACK = "env_feedback"
    """From environment feedback (fail→pass loop)."""
    ROUTINE_DISCOVERY = "routine"
    """From discovering hidden rules/routines in the codebase."""
    USER_REJECTION = "user_rejection"
    """From user rejection of an action."""
    USER_APPROVAL = "user_approval"
    """From user approval/positive feedback."""
    MANUAL = "manual"
    """Manually created by agent or user."""


class Evidence(BaseModel):
    """Evidence supporting a lesson."""

    model_config = ConfigDict(extra="ignore")

    trajectory_summary: str
    """Summary of the trajectory that led to this lesson."""
    fail_signal: str | None = None
    """The failure signal (error message, exit code, etc.)."""
    pass_signal: str | None = None
    """The success signal after fix."""
    verification: str
    """Why we believe the fix is effective."""


class LessonMeta(BaseModel):
    """
    Metadata for a lesson, stored in LESSON.meta.json.

    This contains lifecycle management data that is not part of the SKILL.md.
    """

    model_config = ConfigDict(extra="ignore")

    id: str
    """Unique identifier for the lesson."""
    source: LessonSource
    """How the lesson was created."""

    trigger_signatures: list[str] = Field(default_factory=list)
    """Patterns that trigger this lesson (regex, error codes, file paths)."""
    tags: list[str] = Field(default_factory=list)
    """Tags for categorization and retrieval."""

    evidence: Evidence
    """Evidence supporting this lesson."""

    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    """Confidence score (0-1), representing evidence strength."""
    utility: float = Field(default=0.5, ge=0.0, le=1.0)
    """Utility score (0-1), representing how much time/steps saved when matched."""

    created_at: datetime
    """When the lesson was created."""
    last_used_at: datetime | None = None
    """When the lesson was last used/matched."""
    use_count: int = Field(default=0, ge=0)
    """Number of times this lesson has been used."""
    cumulative_effectiveness: float = Field(default=0.0, ge=0.0)
    """Cumulative effectiveness score from all usages (sum of effectiveness ratings)."""
    steps_since_creation: int = Field(default=0, ge=0)
    """Number of steps that have passed since this lesson was created."""

    session_id: str | None = None
    """Session ID where this lesson was created."""
    checkpoint_id: int | None = None
    """Checkpoint ID where this lesson was created."""


class LessonCreate(BaseModel):
    """Data required to create a new lesson."""

    model_config = ConfigDict(extra="ignore")

    name: str
    """Name of the lesson (will be slugified for directory name)."""
    source: LessonSource
    """How the lesson was created."""

    trigger_signatures: list[str] = Field(default_factory=list)
    """Patterns that trigger this lesson."""
    tags: list[str] = Field(default_factory=list)
    """Tags for categorization."""

    symptom: str
    """Description of the problem/symptom (1-2 sentences)."""
    fix_workflow: list[str]
    """Steps to fix the problem."""
    contraindications: list[str] = Field(default_factory=list)
    """Actions to avoid."""

    evidence: Evidence
    """Evidence supporting this lesson."""

    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    """Initial confidence score."""
    utility: float = Field(default=0.5, ge=0.0, le=1.0)
    """Initial utility score."""

    session_id: str | None = None
    """Session ID where this lesson was created."""
    checkpoint_id: int | None = None
    """Checkpoint ID where this lesson was created."""


class LessonUpdate(BaseModel):
    """Data for updating an existing lesson."""

    model_config = ConfigDict(extra="ignore")

    # Content updates (will regenerate SKILL.md)
    symptom: str | None = None
    fix_workflow: list[str] | None = None
    contraindications: list[str] | None = None

    # Meta updates
    trigger_signatures: list[str] | None = None
    tags: list[str] | None = None
    evidence: Evidence | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    utility: float | None = Field(default=None, ge=0.0, le=1.0)
    cumulative_effectiveness: float | None = Field(default=None, ge=0.0)
    steps_since_creation: int | None = Field(default=None, ge=0)
