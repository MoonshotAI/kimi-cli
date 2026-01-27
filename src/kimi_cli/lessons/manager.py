"""LessonManager for CRUD operations on lessons."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger

from kimi_cli.lessons.models import (
    Evidence,
    LessonCreate,
    LessonMeta,
    LessonUpdate,
)


class LessonNotFoundError(Exception):
    """Raised when a lesson is not found."""

    def __init__(self, lesson_id: str):
        self.lesson_id = lesson_id
        super().__init__(f"Lesson not found: {lesson_id}")


class LessonWritePermissionError(Exception):
    """Raised when attempting to write to a path outside allowed directories."""

    def __init__(self, path: Path, allowed_dirs: list[Path]):
        self.path = path
        self.allowed_dirs = allowed_dirs
        dirs_str = ", ".join(str(d) for d in allowed_dirs)
        super().__init__(
            f"Write permission denied: {path} is not within allowed directories: {dirs_str}"
        )


class LessonManager:
    """
    Manages the lifecycle of lessons (CRUD operations).

    Lessons are stored as special skills in the project's skills directory.
    Directory priority: .kimi/skills > .agent/skills > .claude/skills

    Each lesson consists of:
    - SKILL.md: Standard skill format with type: lesson
    - LESSON.meta.json: Lesson-specific metadata
    """

    # Skills directory names in priority order
    SKILLS_DIR_NAMES = [".kimi/skills", ".agent/skills", ".claude/skills"]

    def __init__(self, work_dir: Path):
        """
        Initialize LessonManager.

        Args:
            work_dir: The project working directory.
        """
        self.work_dir = work_dir
        self._skills_dir: Path | None = None

    @property
    def skills_dir(self) -> Path:
        """
        Get the skills directory, finding existing or creating .kimi/skills.

        Priority: .kimi/skills > .agent/skills > .claude/skills
        If none exists, creates .kimi/skills.
        """
        if self._skills_dir is not None:
            return self._skills_dir

        # Find existing skills directory
        for dir_name in self.SKILLS_DIR_NAMES:
            candidate = self.work_dir / dir_name
            if candidate.exists():
                self._skills_dir = candidate
                logger.debug("[Lessons] Using existing skills dir: {}", candidate)
                return self._skills_dir

        # None exists, create .kimi/skills
        self._skills_dir = self.work_dir / ".kimi/skills"
        self._skills_dir.mkdir(parents=True, exist_ok=True)
        logger.info("[Lessons] Created skills dir: {}", self._skills_dir)
        return self._skills_dir

    def _validate_write_path(self, path: Path) -> None:
        """
        Validate that a path is within the skills directory.

        Raises:
            LessonWritePermissionError: If path is not within skills directory.
        """
        resolved_path = path.resolve()
        skills_dir = self.skills_dir.resolve()
        try:
            resolved_path.relative_to(skills_dir)
        except ValueError:
            raise LessonWritePermissionError(path, [skills_dir]) from None

    @staticmethod
    def create_from_work_dir(work_dir: Path) -> LessonManager:
        """
        Create LessonManager from a work directory path.

        Args:
            work_dir: The project working directory.
        """
        return LessonManager(work_dir)

    def _slugify(self, name: str) -> str:
        """Convert a lesson name to a valid directory name."""
        # Convert to lowercase and replace spaces/underscores with hyphens
        slug = name.lower().replace(" ", "-").replace("_", "-")
        # Remove any characters that aren't alphanumeric or hyphens
        slug = re.sub(r"[^a-z0-9-]", "", slug)
        # Remove consecutive hyphens
        slug = re.sub(r"-+", "-", slug)
        # Remove leading/trailing hyphens
        slug = slug.strip("-")
        return slug or "lesson"

    def _render_skill_md(self, lesson: LessonCreate) -> str:
        """Generate SKILL.md content from a LessonCreate object."""
        triggers_desc = ", ".join(lesson.trigger_signatures[:3])
        if len(lesson.trigger_signatures) > 3:
            triggers_desc += ", ..."

        contraindications = ""
        if lesson.contraindications:
            contraindications = "\n".join(f"- **Don't** {c}" for c in lesson.contraindications)
        else:
            contraindications = "None."

        workflow_steps = "\n".join(f"{i + 1}. {step}" for i, step in enumerate(lesson.fix_workflow))

        return f"""---
name: {self._slugify(lesson.name)}
description: |
  {lesson.symptom}
  Trigger: {triggers_desc}
type: lesson
---

# {lesson.name}

## Symptom
{lesson.symptom}

## Fix Workflow
{workflow_steps}

## Contraindications
{contraindications}
"""

    def _render_skill_md_from_update(
        self,
        meta: LessonMeta,
        old_content: str,
        update: LessonUpdate,
    ) -> str:
        """Generate updated SKILL.md content from an update."""
        # Parse existing content to extract parts we're not updating
        from kimi_cli.utils.frontmatter import parse_frontmatter

        frontmatter = parse_frontmatter(old_content) or {}
        name = frontmatter.get("name", "lesson")

        # Use update values or extract from old content
        symptom = update.symptom
        fix_workflow = update.fix_workflow
        contraindications = update.contraindications

        # If not updating, try to parse from old content
        if symptom is None:
            # Extract symptom from description in frontmatter
            desc = frontmatter.get("description", "")
            symptom = desc.split("\n")[0].strip() if isinstance(desc, str) else "Unknown symptom"

        if fix_workflow is None:
            fix_workflow = ["See original lesson for workflow steps"]

        if contraindications is None:
            contraindications = []

        triggers_desc = ", ".join((update.trigger_signatures or meta.trigger_signatures)[:3])

        contra_text = ""
        if contraindications:
            contra_text = "\n".join(f"- **Don't** {c}" for c in contraindications)
        else:
            contra_text = "None."

        workflow_steps = "\n".join(f"{i + 1}. {step}" for i, step in enumerate(fix_workflow))

        return f"""---
name: {name}
description: |
  {symptom}
  Trigger: {triggers_desc}
type: lesson
---

# {name}

## Symptom
{symptom}

## Fix Workflow
{workflow_steps}

## Contraindications
{contra_text}
"""

    def create(self, lesson: LessonCreate) -> Path:
        """
        Create a new lesson.

        Args:
            lesson: LessonCreate object with lesson data.

        Returns:
            Path to the created lesson directory.

        Raises:
            LessonWritePermissionError: If target directory is not allowed.
        """
        target_dir = self.skills_dir

        lesson_dir = target_dir / self._slugify(lesson.name)

        # Handle name collision by appending a number
        base_dir = lesson_dir
        counter = 1
        while lesson_dir.exists():
            lesson_dir = base_dir.parent / f"{base_dir.name}-{counter}"
            counter += 1

        lesson_dir.mkdir(parents=True, exist_ok=True)
        logger.info("Creating lesson at: {}", lesson_dir)

        # Generate and write SKILL.md
        skill_md_content = self._render_skill_md(lesson)
        (lesson_dir / "SKILL.md").write_text(skill_md_content, encoding="utf-8")

        # Generate and write LESSON.meta.json
        meta = LessonMeta(
            id=str(uuid.uuid4()),
            source=lesson.source,
            trigger_signatures=lesson.trigger_signatures,
            tags=lesson.tags,
            evidence=lesson.evidence,
            confidence=lesson.confidence,
            utility=lesson.utility,
            created_at=datetime.now(UTC),
            session_id=lesson.session_id,
            checkpoint_id=lesson.checkpoint_id,
        )
        (lesson_dir / "LESSON.meta.json").write_text(
            meta.model_dump_json(indent=2), encoding="utf-8"
        )

        return lesson_dir

    def update(self, lesson_id: str, updates: LessonUpdate) -> Path:
        """
        Update an existing lesson.

        Args:
            lesson_id: The lesson ID to update.
            updates: LessonUpdate object with fields to update.

        Returns:
            Path to the updated lesson directory.

        Raises:
            LessonNotFoundError: If the lesson is not found.
            LessonWritePermissionError: If lesson directory is not in allowed paths.
        """
        lesson_dir = self.find_by_id(lesson_id)
        if not lesson_dir:
            raise LessonNotFoundError(lesson_id)

        # Validate write permission
        self._validate_write_path(lesson_dir)

        # Load existing meta
        meta = self.load_meta(lesson_dir)
        if meta is None:
            raise LessonNotFoundError(lesson_id)

        # Apply meta updates
        update_dict = updates.model_dump(exclude_unset=True)
        content_fields = {"symptom", "fix_workflow", "contraindications"}
        meta_updates = {k: v for k, v in update_dict.items() if k not in content_fields}

        for key, value in meta_updates.items():
            if hasattr(meta, key) and value is not None:
                setattr(meta, key, value)

        # Update last_used_at
        meta.last_used_at = datetime.now(UTC)

        # Write updated meta
        (lesson_dir / "LESSON.meta.json").write_text(
            meta.model_dump_json(indent=2), encoding="utf-8"
        )

        # Update SKILL.md if content fields are being updated
        if any(k in content_fields for k in update_dict):
            old_content = (lesson_dir / "SKILL.md").read_text(encoding="utf-8")
            new_content = self._render_skill_md_from_update(meta, old_content, updates)
            (lesson_dir / "SKILL.md").write_text(new_content, encoding="utf-8")

        logger.info("Updated lesson: {}", lesson_id)
        return lesson_dir

    def delete(self, lesson_id: str) -> bool:
        """
        Delete a lesson.

        Args:
            lesson_id: The lesson ID to delete.

        Returns:
            True if the lesson was deleted, False if not found.

        Raises:
            LessonWritePermissionError: If lesson directory is not in allowed paths.
        """
        lesson_dir = self.find_by_id(lesson_id)
        if not lesson_dir:
            return False

        # Validate write permission
        self._validate_write_path(lesson_dir)

        shutil.rmtree(lesson_dir)
        logger.info("Deleted lesson: {}", lesson_id)
        return True

    def record_usage(self, lesson_id: str) -> bool:
        """
        Record that a lesson was used.

        Args:
            lesson_id: The lesson ID that was used.

        Returns:
            True if the usage was recorded, False if lesson not found.
        """
        lesson_dir = self.find_by_id(lesson_id)
        if not lesson_dir:
            return False

        meta = self.load_meta(lesson_dir)
        if meta is None:
            return False

        meta.last_used_at = datetime.now(UTC)
        meta.use_count += 1

        (lesson_dir / "LESSON.meta.json").write_text(
            meta.model_dump_json(indent=2), encoding="utf-8"
        )
        return True

    def record_usage_with_effectiveness(
        self,
        lesson_id: str,
        use_count: int,
        effectiveness: float,
    ) -> bool:
        """
        Record lesson usage with effectiveness score from LLM judgment.

        Args:
            lesson_id: The lesson ID that was used.
            use_count: Number of times the lesson was used in this window.
            effectiveness: Effectiveness score (0-1) from LLM judgment.

        Returns:
            True if the usage was recorded, False if lesson not found.
        """
        lesson_dir = self.find_by_id(lesson_id)
        if not lesson_dir:
            return False

        meta = self.load_meta(lesson_dir)
        if meta is None:
            return False

        meta.last_used_at = datetime.now(UTC)
        meta.use_count += use_count
        meta.cumulative_effectiveness += effectiveness * use_count

        (lesson_dir / "LESSON.meta.json").write_text(
            meta.model_dump_json(indent=2), encoding="utf-8"
        )
        logger.debug(
            "Recorded usage for lesson {}: count={}, effectiveness={}",
            lesson_id[:8],
            use_count,
            effectiveness,
        )
        return True

    def increment_steps(self, step_count: int = 1) -> None:
        """
        Increment steps_since_creation for all lessons.

        Called after each step window to track lesson age in steps.

        Args:
            step_count: Number of steps to add (default: 1).
        """
        skills_dir = self.skills_dir
        if not skills_dir.exists():
            return

        for item in skills_dir.iterdir():
            if not item.is_dir():
                continue

            meta = self.load_meta(item)
            if meta is None:
                continue

            meta.steps_since_creation += step_count
            (item / "LESSON.meta.json").write_text(meta.model_dump_json(indent=2), encoding="utf-8")

    def find_similar(
        self, triggers: list[str], threshold: float = 0.5
    ) -> tuple[Path, LessonMeta] | None:
        """
        Find a lesson with similar trigger signatures.

        Args:
            triggers: List of trigger signatures to match.
            threshold: Minimum overlap ratio to consider a match.

        Returns:
            Tuple of (lesson_dir, meta) if found, None otherwise.
        """
        skills_dir = self.skills_dir
        if not skills_dir.exists():
            return None

        for item in skills_dir.iterdir():
            if not item.is_dir():
                continue

            meta = self.load_meta(item)
            if meta is None:
                continue

            if self._triggers_overlap(meta.trigger_signatures, triggers, threshold):
                return item, meta

        return None

    def merge_or_create(self, lesson: LessonCreate) -> tuple[Path, bool]:
        """
        Merge with existing similar lesson or create a new one.

        Args:
            lesson: LessonCreate object with lesson data.

        Returns:
            Tuple of (lesson_dir, is_new).
        """
        existing = self.find_similar(lesson.trigger_signatures)
        if existing:
            path, meta = existing
            # Merge evidence and increase confidence
            merged_evidence = self.merge_evidence(meta.evidence, lesson.evidence)
            self.update(
                meta.id,
                LessonUpdate(
                    evidence=merged_evidence,
                    confidence=min(1.0, meta.confidence + 0.1),
                    # Merge triggers
                    trigger_signatures=list(
                        set(meta.trigger_signatures) | set(lesson.trigger_signatures)
                    ),
                    # Merge tags
                    tags=list(set(meta.tags) | set(lesson.tags)),
                ),
            )
            logger.info("Merged lesson into existing: {}", meta.id)
            return path, False
        else:
            path = self.create(lesson)
            return path, True

    # Maximum number of lessons to keep
    MAX_LESSONS = 20

    def evict(self, max_count: int | None = None) -> list[str]:
        """
        Evict low-scoring lessons to keep the total under max_count.

        Uses a scoring formula that considers:
        - Call frequency: use_count / steps_since_creation
        - Freshness: decay based on last_used_at
        - Effectiveness: cumulative_effectiveness / use_count

        Args:
            max_count: Maximum number of lessons to keep. Defaults to MAX_LESSONS (20).

        Returns:
            List of evicted lesson IDs.
        """
        if max_count is None:
            max_count = self.MAX_LESSONS

        all_lessons: list[tuple[Path, LessonMeta, float]] = []

        skills_dir = self.skills_dir
        if skills_dir.exists():
            for item in skills_dir.iterdir():
                if not item.is_dir():
                    continue

                meta = self.load_meta(item)
                if meta is None:
                    continue

                score = self._calculate_score(meta)
                all_lessons.append((item, meta, score))

        # Sort by score descending
        all_lessons.sort(key=lambda x: x[2], reverse=True)

        # Log all lessons with scores
        logger.debug("[Lessons] Lesson scores (sorted by score desc):")
        for i, (path, meta, score) in enumerate(all_lessons):
            logger.debug(
                "[Lessons]   #{} {} (id={}): score={:.4f} "
                "(uses={}, steps={}, effectiveness={:.2f}, freshness={:.2f})",
                i + 1,
                path.name,
                meta.id[:8],
                score,
                meta.use_count,
                meta.steps_since_creation,
                meta.cumulative_effectiveness / max(1, meta.use_count),
                self._freshness_decay(meta.last_used_at),
            )

        # Evict lessons beyond max_count
        evicted: list[str] = []
        for path, meta, score in all_lessons[max_count:]:
            evicted.append(meta.id)
            shutil.rmtree(path)
            logger.info(
                "[Lessons] Evicted lesson: {} '{}' (score: {:.4f})",
                meta.id[:8],
                path.name,
                score,
            )

        return evicted

    def get_lesson_count(self) -> int:
        """Get the total number of lessons."""
        count = 0
        skills_dir = self.skills_dir
        if not skills_dir.exists():
            return 0
        for item in skills_dir.iterdir():
            if item.is_dir() and (item / "LESSON.meta.json").exists():
                count += 1
        return count

    def should_evict(self) -> bool:
        """Check if eviction is needed (lesson count >= MAX_LESSONS)."""
        return self.get_lesson_count() >= self.MAX_LESSONS

    def list_lessons(self) -> list[tuple[Path, LessonMeta]]:
        """
        List all lessons.

        Returns:
            List of (lesson_dir, meta) tuples.
        """
        lessons: list[tuple[Path, LessonMeta]] = []

        skills_dir = self.skills_dir
        if not skills_dir.exists():
            return lessons

        for item in skills_dir.iterdir():
            if not item.is_dir():
                continue

            meta = self.load_meta(item)
            if meta is not None:
                lessons.append((item, meta))

        return lessons

    def find_by_id(self, lesson_id: str) -> Path | None:
        """Find a lesson directory by its ID."""
        skills_dir = self.skills_dir
        if not skills_dir.exists():
            return None

        for item in skills_dir.iterdir():
            if not item.is_dir():
                continue

            meta_file = item / "LESSON.meta.json"
            if not meta_file.exists():
                continue

            try:
                meta_data = json.loads(meta_file.read_text(encoding="utf-8"))
                if meta_data.get("id") == lesson_id:
                    return item
            except (json.JSONDecodeError, OSError):
                continue

        return None

    def load_meta(self, lesson_dir: Path) -> LessonMeta | None:
        """Load lesson metadata from a directory."""
        meta_file = lesson_dir / "LESSON.meta.json"
        if not meta_file.exists():
            return None

        try:
            meta_content = meta_file.read_text(encoding="utf-8")
            return LessonMeta.model_validate_json(meta_content)
        except Exception as exc:
            logger.warning("Failed to load lesson meta from {}: {}", meta_file, exc)
            return None

    def _triggers_overlap(
        self, existing: list[str], new: list[str], threshold: float = 0.5
    ) -> bool:
        """Check if two lists of triggers have significant overlap."""
        if not existing or not new:
            return False

        existing_set = set(t.lower() for t in existing)
        new_set = set(t.lower() for t in new)

        intersection = existing_set & new_set
        union = existing_set | new_set

        if not union:
            return False

        overlap_ratio = len(intersection) / len(union)
        return overlap_ratio >= threshold

    def merge_evidence(self, existing: Evidence, new: Evidence) -> Evidence:
        """Merge two evidence objects."""
        return Evidence(
            trajectory_summary=(
                f"{existing.trajectory_summary}\n\nAdditional evidence:\n{new.trajectory_summary}"
            ),
            fail_signal=new.fail_signal or existing.fail_signal,
            pass_signal=new.pass_signal or existing.pass_signal,
            verification=(
                f"{existing.verification}; {new.verification}"
                if new.verification != existing.verification
                else existing.verification
            ),
        )

    def _calculate_score(self, meta: LessonMeta) -> float:
        """
        Calculate a score for lesson ranking/eviction.

        Score formula:
        - Call frequency: use_count / max(1, steps_since_creation) (normalized by age in steps)
        - Freshness: decay factor based on last_used_at (0.5 to 1.0)
        - Effectiveness: cumulative_effectiveness / max(1, use_count) (average effectiveness)

        Final score = call_frequency * freshness * effectiveness * base_quality
        """
        # Call frequency: use_count / steps_since_creation
        # Higher frequency = more useful lesson
        steps = max(1, meta.steps_since_creation)
        call_frequency = meta.use_count / steps

        # Freshness decay
        freshness = self._freshness_decay(meta.last_used_at)

        # Average effectiveness from LLM judgments
        # If never used, assume baseline effectiveness of 0.5
        if meta.use_count > 0:
            avg_effectiveness = meta.cumulative_effectiveness / meta.use_count
        else:
            avg_effectiveness = 0.5

        # Combine all factors
        # Also factor in confidence and utility as baseline quality indicators
        base_quality = (meta.confidence + meta.utility) / 2

        # Final score: frequency * freshness * effectiveness * quality
        score = call_frequency * freshness * avg_effectiveness * base_quality

        logger.trace(
            "[Lessons] Score for {}: {:.4f} = freq({:.3f}) * fresh({:.2f}) "
            "* eff({:.2f}) * qual({:.2f})",
            meta.id[:8],
            score,
            call_frequency,
            freshness,
            avg_effectiveness,
            base_quality,
        )

        return score

    def _freshness_decay(self, last_used_at: datetime | None) -> float:
        """Calculate freshness decay factor (0.5 to 1.0)."""
        if last_used_at is None:
            return 0.5

        now = datetime.now(UTC)
        # Handle timezone-naive datetimes
        if last_used_at.tzinfo is None:
            last_used_at = last_used_at.replace(tzinfo=UTC)

        days_since_use = (now - last_used_at).days

        # Decay from 1.0 to 0.5 over 90 days
        decay = max(0.5, 1.0 - (days_since_use / 180))
        return decay
