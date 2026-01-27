"""LessonExtractor for auto-extracting lessons from agent trajectories."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from kosong.message import Message
from loguru import logger

from kimi_cli.lessons.models import (
    Evidence,
    LessonCreate,
    LessonSource,
)

if TYPE_CHECKING:
    from kimi_cli.lessons.judge import (
        CreateInstruction,
        ExistingLessonSummary,
        JudgmentResult,
        LessonJudge,
        LessonPlan,
        MergeInstruction,
    )
    from kimi_cli.lessons.manager import LessonManager


@dataclass
class UserFeedback:
    """Record of user feedback (rejection, approval, criticism, praise)."""

    type: str  # "rejection", "approval", "criticism", "praise"
    action: str
    reason: str | None = None
    context_summary: str = ""


@dataclass
class StepWindow:
    """
    Sliding window collecting messages from N steps.

    Collects full message context in kosong format for LLM judgment.
    """

    messages: list[Message] = field(default_factory=lambda: list[Message]())
    """Full message history in this window (user, assistant, tool messages)."""

    user_feedbacks: list[UserFeedback] = field(default_factory=lambda: list[UserFeedback]())
    """User feedback events (rejections, approvals, criticisms, praises)."""

    def has_content(self) -> bool:
        """Check if the window has any content worth processing."""
        return bool(self.messages)

    def clear(self) -> None:
        """Clear all collected data."""
        self.messages.clear()
        self.user_feedbacks.clear()


class LessonExtractor:
    """
    Extracts lessons from agent trajectories using LLM judgment.

    Collects full message context over N steps, then triggers LLM to analyze
    the trajectory and determine if lessons should be created.
    """

    def __init__(
        self,
        manager: LessonManager,
        judge: LessonJudge,
        *,
        window_size: int = 5,
        session_id: str | None = None,
    ):
        """
        Initialize LessonExtractor.

        Args:
            manager: LessonManager for saving lessons.
            judge: LessonJudge for evaluating if lessons should be created.
            window_size: Number of steps between lesson checks (across turns).
            session_id: Current session ID for tracking.
        """
        self.manager = manager
        self.judge = judge
        self.window_size = window_size
        self.session_id = session_id

        self._window = StepWindow()
        self._step_count = 0
        self._last_trigger_step = 0
        self._judge_task: asyncio.Task[None] | None = None
        self._on_lesson_created: list[Callable[[int], None]] = []

    def on_lesson_created(self, callback: Callable[[int], None]) -> None:
        """Register a callback to be called when a lesson is created."""
        self._on_lesson_created.append(callback)

    def on_message(self, message: Message) -> None:
        """
        Called when a message is added to the conversation.

        Collects all messages (user, assistant, tool) for context.

        Args:
            message: The message to collect.
        """
        self._window.messages.append(message)

    def on_step_complete(self) -> None:
        """
        Called after each step (assistant response + tool execution) completes.

        This is lightweight - only increments step count and checks trigger.
        """
        self._step_count += 1
        logger.debug(
            "[Lessons] Step {} completed, window has {} messages, {} until next judge",
            self._step_count,
            len(self._window.messages),
            self.window_size - (self._step_count - self._last_trigger_step),
        )

        # Check if we should trigger judgment
        if self._should_trigger_judge():
            logger.info("[Lessons] Triggering lesson judgment at step {}", self._step_count)
            self._trigger_judge_async()

    def on_user_feedback(
        self,
        feedback_type: str,
        action: str,
        reason: str | None = None,
        context_summary: str = "",
    ) -> None:
        """
        Called when user provides feedback (rejection, approval, criticism, praise).

        Args:
            feedback_type: Type of feedback ("rejection", "approval", "criticism", "praise").
            action: Description of the action being evaluated.
            reason: User's reason (if provided).
            context_summary: Summary of the context.
        """
        feedback = UserFeedback(
            type=feedback_type,
            action=action,
            reason=reason,
            context_summary=context_summary,
        )
        self._window.user_feedbacks.append(feedback)
        logger.info("Recorded user {}: {}", feedback_type, action)

    def _should_trigger_judge(self) -> bool:
        """Determine if we should trigger the judge."""
        steps_since_trigger = self._step_count - self._last_trigger_step
        return steps_since_trigger >= self.window_size

    def _trigger_judge_async(self) -> None:
        """Trigger async judgment (non-blocking)."""
        # Avoid duplicate triggers
        if self._judge_task and not self._judge_task.done():
            return

        # Check if window has content
        if not self._window.has_content():
            self._last_trigger_step = self._step_count
            return

        # Update last trigger step
        self._last_trigger_step = self._step_count

        # Snapshot current window and reset
        window_snapshot = self._window
        self._window = StepWindow()

        # Run judge asynchronously
        self._judge_task = asyncio.create_task(self._judge_window(window_snapshot))

    async def _judge_window(self, window: StepWindow) -> None:
        """
        Process a window of collected messages using LLM judgment.

        Flow:
        1. Judge lesson usage and record effectiveness (LLM)
        2. Increment steps for all lessons
        3. Extract new lessons from trajectory (LLM)
        4. Match with existing lessons (LLM)
        5. Check capacity and evict if needed
        6. Execute merge/create tasks in parallel
        """
        try:
            logger.info(
                "[Lessons] === Starting window judgment ({} messages, {} user feedbacks) ===",
                len(window.messages),
                len(window.user_feedbacks),
            )

            # Step 1: Get existing lessons for usage judgment
            existing_summaries = self._get_existing_lesson_summaries()
            logger.debug(
                "[Lessons] Found {} existing lessons: {}",
                len(existing_summaries),
                [s.name for s in existing_summaries],
            )

            # Step 2: Judge which lessons were used and their effectiveness
            if existing_summaries:
                logger.debug("[Lessons] Judging lesson usage with LLM...")
                await self._judge_and_record_usage(window.messages, existing_summaries)
            else:
                logger.debug("[Lessons] No existing lessons to judge usage for")

            # Step 3: Increment steps for all lessons (age tracking)
            self.manager.increment_steps(self.window_size)
            logger.debug("[Lessons] Incremented steps by {} for all lessons", self.window_size)

            # Step 4: Extract new lessons from trajectory
            logger.debug("[Lessons] Extracting new lessons from trajectory with LLM...")
            judgments = await self.judge.judge_trajectory(
                messages=window.messages,
                user_feedbacks=window.user_feedbacks,
            )
            logger.debug(
                "[Lessons] LLM returned {} judgment(s): {}",
                len(judgments),
                [(j.name, j.should_save) for j in judgments],
            )

            # Filter to only lessons that should be saved
            new_lessons = [j for j in judgments if j.should_save]
            if not new_lessons:
                logger.info("[Lessons] No lessons to save from this window")
                return

            logger.info(
                "[Lessons] Extracted {} potential lesson(s): {}",
                len(new_lessons),
                [lesson.name for lesson in new_lessons],
            )

            # Step 5: Match and plan
            logger.debug("[Lessons] Matching and planning with LLM...")
            plan = await self.judge.match_and_plan_lessons(new_lessons, existing_summaries)

            logger.info(
                "[Lessons] Plan: {} merge(s), {} create(s)",
                len(plan.merges),
                len(plan.creates),
            )
            for m in plan.merges:
                logger.debug(
                    "[Lessons]   Merge: new_lesson[{}] -> existing '{}': {}",
                    m.new_lesson_index,
                    m.existing_lesson_id[:8],
                    m.merge_reason,
                )
            for c in plan.creates:
                logger.debug("[Lessons]   Create: new_lesson[{}]", c.new_lesson_index)

            # Step 6: Check capacity and evict if needed before creating new lessons
            current_count = self.manager.get_lesson_count()
            logger.debug(
                "[Lessons] Current lesson count: {}/{}", current_count, self.manager.MAX_LESSONS
            )
            if plan.creates and self.manager.should_evict():
                logger.info("[Lessons] At capacity, triggering eviction...")
                evicted = self.manager.evict()
                if evicted:
                    logger.info("[Lessons] Evicted {} lesson(s): {}", len(evicted), evicted)

            # Step 7: Execute in parallel
            logger.debug("[Lessons] Executing plan...")
            lessons_created = await self._execute_plan(plan, new_lessons)

            if lessons_created > 0:
                logger.info(
                    "[Lessons] === Successfully created/updated {} lesson(s) ===",
                    lessons_created,
                )
                for callback in self._on_lesson_created:
                    try:
                        callback(lessons_created)
                    except Exception as e:
                        logger.warning("[Lessons] Lesson callback failed: {}", e)
            else:
                logger.info("[Lessons] === No lessons were created/updated ===")

        except Exception as e:
            logger.exception("[Lessons] Failed to judge window: {}", e)

    async def _judge_and_record_usage(
        self,
        messages: list[Message],
        existing_summaries: list[ExistingLessonSummary],
    ) -> None:
        """
        Judge which lessons were used in this window and record their effectiveness.

        Args:
            messages: Messages from the step window.
            existing_summaries: Summaries of existing lessons.
        """
        try:
            usage_results = await self.judge.judge_lesson_usage(messages, existing_summaries)

            for usage in usage_results:
                if usage.was_used:
                    self.manager.record_usage_with_effectiveness(
                        lesson_id=usage.lesson_id,
                        use_count=usage.use_count,
                        effectiveness=usage.effectiveness,
                    )
                    logger.debug(
                        "Recorded usage for lesson {}: helpful={}, effectiveness={:.2f}",
                        usage.lesson_id[:8],
                        usage.was_helpful,
                        usage.effectiveness,
                    )

        except Exception as e:
            logger.warning("Failed to judge lesson usage: {}", e)

    def _get_existing_lesson_summaries(self) -> list[ExistingLessonSummary]:
        """Get summaries of all existing lessons for matching."""
        from kimi_cli.lessons.judge import ExistingLessonSummary

        summaries: list[ExistingLessonSummary] = []
        for path, meta in self.manager.list_lessons():
            # Read symptom from SKILL.md if available
            skill_md = path / "SKILL.md"
            symptom = ""
            if skill_md.exists():
                content = skill_md.read_text(encoding="utf-8")
                # Extract symptom section
                if "## Symptom" in content:
                    start = content.find("## Symptom")
                    end = content.find("##", start + 10)
                    if end == -1:
                        end = len(content)
                    symptom = content[start + 10 : end].strip()[:500]

            summaries.append(
                ExistingLessonSummary(
                    id=meta.id,
                    name=path.name,
                    trigger_signatures=meta.trigger_signatures,
                    symptom=symptom,
                    tags=meta.tags,
                )
            )
        return summaries

    async def _execute_plan(
        self,
        plan: LessonPlan,
        new_lessons: list[JudgmentResult],
    ) -> int:
        """
        Execute the lesson plan with parallel tasks.

        Args:
            plan: The LessonPlan with merge and create instructions.
            new_lessons: The list of new lessons from judgment.

        Returns:
            Number of lessons created/updated.
        """
        tasks: list[asyncio.Task[bool]] = []

        # Create tasks for merges
        for merge in plan.merges:
            if merge.new_lesson_index < len(new_lessons):
                new_lesson = new_lessons[merge.new_lesson_index]
                task = asyncio.create_task(
                    self._execute_merge(merge, new_lesson),
                    name=f"merge-{merge.existing_lesson_id[:8]}",
                )
                tasks.append(task)

        # Create tasks for creates
        for create in plan.creates:
            if create.new_lesson_index < len(new_lessons):
                new_lesson = new_lessons[create.new_lesson_index]
                task = asyncio.create_task(
                    self._execute_create(create, new_lesson),
                    name=f"create-{new_lesson.name}",
                )
                tasks.append(task)

        if not tasks:
            return 0

        # Execute all tasks in parallel
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Count successes
        success_count = sum(1 for r in results if r is True)
        for r in results:
            if isinstance(r, Exception):
                logger.warning("Lesson task failed: {}", r)

        return success_count

    async def _execute_merge(
        self,
        merge: MergeInstruction,
        new_lesson: JudgmentResult,
    ) -> bool:
        """
        Execute a merge operation using LLM to rewrite content.

        Uses LLM to merge existing lesson content with new lesson,
        ensuring coherent and non-redundant content.
        """
        try:
            # Find the existing lesson
            lesson_dir = self.manager.find_by_id(merge.existing_lesson_id)
            if not lesson_dir:
                logger.warning("Existing lesson not found: {}", merge.existing_lesson_id)
                return False

            # Load existing meta
            meta = self.manager.load_meta(lesson_dir)
            if not meta:
                return False

            # Read existing SKILL.md to get current content
            existing_symptom, existing_workflow, existing_contra = self._parse_skill_md(
                lesson_dir / "SKILL.md"
            )

            # Use LLM to rewrite/merge content
            rewrite_result = await self.judge.rewrite_lesson_content(
                existing_symptom=existing_symptom,
                existing_fix_workflow=existing_workflow,
                existing_contraindications=existing_contra,
                existing_triggers=meta.trigger_signatures,
                new_lesson=new_lesson,
            )

            # Create merged evidence
            new_evidence = Evidence(
                trajectory_summary=new_lesson.trajectory_summary,
                fail_signal=new_lesson.fail_signal,
                pass_signal=new_lesson.pass_signal,
                verification=new_lesson.verification or "Verified by LLM analysis",
            )
            merged_evidence = self.manager.merge_evidence(meta.evidence, new_evidence)

            # Update the lesson with rewritten content
            from kimi_cli.lessons.models import LessonUpdate

            if rewrite_result:
                # Use LLM-rewritten content
                self.manager.update(
                    meta.id,
                    LessonUpdate(
                        symptom=rewrite_result.symptom,
                        fix_workflow=rewrite_result.fix_workflow,
                        contraindications=rewrite_result.contraindications,
                        evidence=merged_evidence,
                        confidence=min(1.0, meta.confidence + 0.1),
                        trigger_signatures=rewrite_result.trigger_signatures,
                        tags=list(set(meta.tags) | set(new_lesson.tags or [])),
                    ),
                )
            else:
                # Fallback: just merge evidence and triggers without rewriting content
                self.manager.update(
                    meta.id,
                    LessonUpdate(
                        evidence=merged_evidence,
                        confidence=min(1.0, meta.confidence + 0.1),
                        trigger_signatures=list(
                            set(meta.trigger_signatures) | set(new_lesson.trigger_signatures)
                        ),
                        tags=list(set(meta.tags) | set(new_lesson.tags or [])),
                    ),
                )

            logger.info(
                "Merged lesson into {}: {}",
                meta.id[:8],
                merge.merge_reason,
            )
            return True

        except Exception as e:
            logger.warning("Failed to merge lesson: {}", e)
            return False

    async def _execute_create(
        self,
        create: CreateInstruction,
        new_lesson: JudgmentResult,
    ) -> bool:
        """
        Execute a create operation.

        For now, this creates a new lesson file directly.
        In the future, this could spawn a subagent to write the lesson.
        """
        try:
            lesson = LessonCreate(
                name=new_lesson.name,
                source=LessonSource(new_lesson.source),
                trigger_signatures=new_lesson.trigger_signatures,
                tags=new_lesson.tags or [],
                symptom=new_lesson.symptom,
                fix_workflow=new_lesson.fix_workflow,
                contraindications=new_lesson.contraindications or [],
                evidence=Evidence(
                    trajectory_summary=new_lesson.trajectory_summary,
                    fail_signal=new_lesson.fail_signal,
                    pass_signal=new_lesson.pass_signal,
                    verification=new_lesson.verification or "Verified by LLM analysis",
                ),
                confidence=new_lesson.confidence,
                utility=new_lesson.utility or 0.5,
                session_id=self.session_id,
            )

            path = self.manager.create(lesson)
            logger.info("Created new lesson: {}", path.name)
            return True

        except Exception as e:
            logger.warning("Failed to create lesson: {}", e)
            return False

    def _parse_skill_md(self, skill_md_path: Path) -> tuple[str, list[str], list[str]]:
        """
        Parse SKILL.md to extract symptom, fix_workflow, and contraindications.

        Args:
            skill_md_path: Path to SKILL.md file.

        Returns:
            Tuple of (symptom, fix_workflow, contraindications).
        """
        if not skill_md_path.exists():
            return "", [], []

        try:
            content = skill_md_path.read_text(encoding="utf-8")

            symptom = ""
            fix_workflow: list[str] = []
            contraindications: list[str] = []

            # Extract Symptom section
            if "## Symptom" in content:
                start = content.find("## Symptom") + len("## Symptom")
                end = content.find("##", start)
                if end == -1:
                    end = len(content)
                symptom = content[start:end].strip()

            # Extract Fix Workflow section
            if "## Fix Workflow" in content:
                start = content.find("## Fix Workflow") + len("## Fix Workflow")
                end = content.find("##", start)
                if end == -1:
                    end = len(content)
                workflow_text = content[start:end].strip()
                # Parse numbered steps
                for line in workflow_text.split("\n"):
                    line = line.strip()
                    # Match lines like "1. Step description" or "- Step description"
                    match = re.match(r"^(?:\d+\.|[-*])\s*(.+)$", line)
                    if match:
                        fix_workflow.append(match.group(1).strip())

            # Extract Contraindications section
            if "## Contraindications" in content:
                start = content.find("## Contraindications") + len("## Contraindications")
                end = content.find("##", start)
                if end == -1:
                    end = len(content)
                contra_text = content[start:end].strip()
                # Parse bullet points
                for line in contra_text.split("\n"):
                    line = line.strip()
                    # Match lines like "- **Don't** do something" or "- Do not do something"
                    if line.startswith("-") or line.startswith("*"):
                        item = line.lstrip("-*").strip()
                        # Remove **Don't** prefix if present
                        item = re.sub(r"^\*\*Don't\*\*\s*", "", item)
                        if item and item.lower() != "none." and item.lower() != "none":
                            contraindications.append(item)

            return symptom, fix_workflow, contraindications

        except Exception as e:
            logger.warning("Failed to parse SKILL.md: {}", e)
            return "", [], []
