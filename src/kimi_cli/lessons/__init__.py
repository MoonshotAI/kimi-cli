"""Lessons module for dynamic experience memory management."""

from __future__ import annotations

from kimi_cli.lessons.extractor import LessonExtractor, UserFeedback
from kimi_cli.lessons.judge import (
    CreateInstruction,
    ExistingLessonSummary,
    JudgmentResult,
    LessonJudge,
    LessonPlan,
    LessonUsageResult,
    MergeInstruction,
    RewriteResult,
)
from kimi_cli.lessons.manager import (
    LessonManager,
    LessonNotFoundError,
    LessonWritePermissionError,
)
from kimi_cli.lessons.models import (
    Evidence,
    LessonCreate,
    LessonMeta,
    LessonSource,
    LessonUpdate,
)

__all__ = [
    "CreateInstruction",
    "Evidence",
    "ExistingLessonSummary",
    "JudgmentResult",
    "LessonCreate",
    "LessonExtractor",
    "LessonJudge",
    "LessonManager",
    "LessonMeta",
    "LessonNotFoundError",
    "LessonPlan",
    "LessonSource",
    "LessonUpdate",
    "LessonUsageResult",
    "LessonWritePermissionError",
    "MergeInstruction",
    "RewriteResult",
    "UserFeedback",
]
