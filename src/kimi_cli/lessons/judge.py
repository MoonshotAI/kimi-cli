"""LessonJudge for LLM-based evaluation of potential lessons."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from loguru import logger
from pydantic import BaseModel

if TYPE_CHECKING:
    from kosong.message import Message

    from kimi_cli.lessons.extractor import UserFeedback
    from kimi_cli.llm import LLM


class JudgmentResult(BaseModel):
    """Result of judging whether to create a lesson."""

    should_save: bool
    """Whether this experience should be saved as a lesson."""
    name: str = ""
    """Suggested name for the lesson."""
    reason: str = ""
    """Reason for the judgment."""

    # Lesson content
    trigger_signatures: list[str] = []
    """Patterns to match for triggering this lesson."""
    symptom: str = ""
    """Description of the problem."""
    fix_workflow: list[str] = []
    """Steps to fix the problem."""
    contraindications: list[str] | None = None
    """Actions to avoid."""

    # Evidence
    trajectory_summary: str = ""
    """Summary of what happened."""
    fail_signal: str | None = None
    """The failure signal."""
    pass_signal: str | None = None
    """The success signal."""
    verification: str | None = None
    """Why the fix is believed to work."""

    # Metadata
    source: str = "env_feedback"
    """Source type (env_feedback, routine, user_rejection, user_approval, manual)."""
    confidence: float = 0.5
    """Confidence in this lesson (0-1)."""
    utility: float | None = None
    """Expected utility (0-1)."""
    tags: list[str] | None = None
    """Suggested tags."""


class MergeInstruction(BaseModel):
    """Instruction to merge a new lesson into an existing one."""

    new_lesson_index: int
    """Index of the new lesson in the judgments list."""
    existing_lesson_id: str
    """ID of the existing lesson to merge into."""
    merge_reason: str
    """Why these lessons should be merged."""
    rewrite_prompt: str
    """Prompt for the subagent to rewrite the merged lesson."""


class CreateInstruction(BaseModel):
    """Instruction to create a new lesson."""

    new_lesson_index: int
    """Index of the new lesson in the judgments list."""
    create_prompt: str
    """Prompt for the subagent to write the new lesson."""


class LessonPlan(BaseModel):
    """Plan for merging and creating lessons."""

    merges: list[MergeInstruction] = []
    """Instructions for merging into existing lessons."""
    creates: list[CreateInstruction] = []
    """Instructions for creating new lessons."""


class ExistingLessonSummary(BaseModel):
    """Summary of an existing lesson for matching."""

    id: str
    name: str
    trigger_signatures: list[str]
    symptom: str
    tags: list[str]


class LessonUsageResult(BaseModel):
    """Result of judging whether a lesson was used and its effectiveness."""

    lesson_id: str
    """ID of the lesson being evaluated."""
    was_used: bool
    """Whether the lesson was used/referenced in this window."""
    use_count: int = 0
    """Number of times the lesson was used in this window."""
    was_helpful: bool = False
    """Whether the lesson helped solve the problem."""
    effectiveness: float = 0.0
    """Effectiveness score (0-1). How much the lesson contributed to task success."""
    reason: str = ""
    """Reason for the judgment."""


USAGE_JUDGE_SYSTEM_PROMPT = """\
You are a lesson usage evaluator. Your task is to analyze an agent trajectory and determine \
which lessons (if any) were used and how effective they were.

## Your Task
Given a trajectory of agent messages and a list of available lessons, determine:
1. Which lessons were actually used or referenced by the agent
2. How many times each lesson was applied
3. Whether each used lesson helped solve the problem
4. The effectiveness of each used lesson (0-1 scale)

## Effectiveness Criteria
- **1.0**: Lesson directly solved the problem, saved significant time/effort
- **0.7-0.9**: Lesson was very helpful, guided the solution effectively
- **0.4-0.6**: Lesson was somewhat helpful, provided useful context
- **0.1-0.3**: Lesson was minimally helpful, only tangentially relevant
- **0.0**: Lesson was not helpful or was misleading

## Response Format
Return a JSON object with usage results for ONLY the lessons that were used:
```json
{
  "usages": [
    {
      "lesson_id": "uuid-of-lesson",
      "was_used": true,
      "use_count": 1,
      "was_helpful": true,
      "effectiveness": 0.8,
      "reason": "The lesson's fix workflow was followed to resolve the error"
    }
  ]
}
```

If no lessons were used, return:
```json
{
  "usages": []
}
```

Only return valid JSON, no other text."""


REWRITE_SYSTEM_PROMPT = """\
You are a lesson consolidation expert. Your task is to merge an existing lesson with new \
evidence and insights to create an improved, coherent lesson.

## Your Task
Given an existing lesson and new lesson information, create a merged lesson that:
1. Combines the best aspects of both
2. Maintains coherent, non-redundant content
3. Preserves all valuable information
4. Has clear, actionable fix workflow steps

## Guidelines
- **Symptom**: Combine both descriptions into a comprehensive but concise symptom
- **Fix Workflow**: Merge steps, remove duplicates, ensure logical order
- **Contraindications**: Combine all warnings, remove duplicates
- **Trigger Signatures**: Union of both sets

## Response Format
Return a JSON object with the merged lesson content:
```json
{
  "symptom": "Merged symptom description (1-3 sentences)",
  "fix_workflow": ["Step 1", "Step 2", "Step 3"],
  "contraindications": ["What to avoid 1", "What to avoid 2"],
  "trigger_signatures": ["pattern1", "pattern2", "pattern3"]
}
```

Only return valid JSON, no other text."""


class RewriteResult(BaseModel):
    """Result of rewriting/merging lesson content."""

    symptom: str
    """Merged symptom description."""
    fix_workflow: list[str]
    """Merged fix workflow steps."""
    contraindications: list[str] = []
    """Merged contraindications."""
    trigger_signatures: list[str] = []
    """Merged trigger signatures."""


JUDGE_SYSTEM_PROMPT = """\
You are an experience summarization expert. Your task is to analyze agent trajectories \
and extract valuable lessons that can help avoid future mistakes or improve efficiency.

A lesson captures reusable knowledge from:
1. **Error Recovery (env_feedback)**: When a tool/command fails and is successfully fixed
2. **Hidden Rules (routine)**: Discovering project conventions or undocumented requirements
3. **User Preferences (user_rejection/user_approval)**: When users reject or approve approaches

## Evaluation Criteria
Only create lessons for experiences that are:
1. **Reusable**: Likely to recur in similar situations
2. **Specific**: Has clear trigger patterns (error messages, file names, commands)
3. **Actionable**: Provides concrete steps to resolve or avoid the issue
4. **Non-trivial**: Not obvious mistakes like typos

## Response Format
Return a JSON object with an array of lessons:
```json
{
  "lessons": [
    {
      "should_save": true,
      "name": "lesson-name-slug",
      "reason": "Why this should be saved",
      "source": "env_feedback|routine|user_rejection|user_approval",
      "trigger_signatures": ["pattern1", "pattern2"],
      "symptom": "What went wrong or what was discovered (1-2 sentences)",
      "fix_workflow": ["Step 1", "Step 2"],
      "contraindications": ["What to avoid"],
      "trajectory_summary": "Brief summary of what happened",
      "fail_signal": "Error message or failure indicator (if applicable)",
      "pass_signal": "Success indicator (if applicable)",
      "verification": "Why the fix works",
      "confidence": 0.0-1.0,
      "utility": 0.0-1.0,
      "tags": ["tag1", "tag2"]
    }
  ]
}
```

If no lessons should be extracted, return:
```json
{
  "lessons": []
}
```

Only return valid JSON, no other text."""


MATCH_SYSTEM_PROMPT = """\
You are a lesson management expert. Your task is to match new lessons with existing ones \
and decide whether to merge or create new lessons.

## Matching Criteria
Two lessons should be MERGED if they:
1. Address the same underlying problem or pattern
2. Have similar trigger signatures (error messages, commands, file patterns)
3. Would benefit from combined evidence and knowledge

Two lessons should be SEPARATE if they:
1. Address different problems, even if superficially similar
2. Would be confusing if combined

## Response Format
Return a JSON object with merge and create instructions:
```json
{
  "merges": [
    {
      "new_lesson_index": 0,
      "existing_lesson_id": "uuid-of-existing-lesson",
      "merge_reason": "Why these should be merged",
      "rewrite_prompt": "Detailed prompt for rewriting the merged lesson"
    }
  ],
  "creates": [
    {
      "new_lesson_index": 1,
      "create_prompt": "Detailed prompt for writing this new lesson"
    }
  ]
}
```

Only return valid JSON, no other text."""


class LessonJudge:
    """
    LLM-based judgment module for evaluating potential lessons.

    Analyzes full message trajectories to determine if experiences should
    be saved as lessons.
    """

    def __init__(
        self,
        llm: LLM | None = None,
    ):
        """
        Initialize LessonJudge.

        Args:
            llm: LLM to use for judgment. Required for lesson extraction.
        """
        self.llm = llm

    async def judge_trajectory(
        self,
        messages: list[Message],
        user_feedbacks: list[UserFeedback],
    ) -> list[JudgmentResult]:
        """
        Judge a trajectory of messages to extract lessons.

        Args:
            messages: Full message history from the step window.
            user_feedbacks: User feedback events during the window.

        Returns:
            List of JudgmentResult with lessons to create.
        """
        if not self.llm:
            logger.debug("No LLM configured, skipping lesson extraction")
            return []

        if not messages:
            return []

        try:
            # Format the trajectory for the LLM
            trajectory_text = self._format_trajectory(messages, user_feedbacks)
            logger.debug(
                "[Lessons] Calling LLM to extract lessons (trajectory: {} chars)",
                len(trajectory_text),
            )

            # Call LLM for judgment
            response = await self._call_llm(JUDGE_SYSTEM_PROMPT, trajectory_text)
            logger.debug("[Lessons] LLM response for trajectory judgment: {} chars", len(response))

            # Parse response
            results = self._parse_judgment_response(response)
            logger.debug(
                "[Lessons] Parsed {} lesson(s) from LLM: {}",
                len(results),
                [(r.name, r.should_save) for r in results],
            )
            return results

        except Exception as e:
            logger.warning("[Lessons] LLM judgment failed: {}", e)
            return []

    async def match_and_plan_lessons(
        self,
        new_lessons: list[JudgmentResult],
        existing_lessons: list[ExistingLessonSummary],
    ) -> LessonPlan:
        """
        Match new lessons with existing ones and create a plan.

        Args:
            new_lessons: List of new lessons extracted from trajectory.
            existing_lessons: List of existing lesson summaries.

        Returns:
            LessonPlan with merge and create instructions.
        """
        if not self.llm:
            logger.debug("No LLM configured, creating all as new")
            return LessonPlan(
                creates=[
                    CreateInstruction(
                        new_lesson_index=i,
                        create_prompt=self._default_create_prompt(lesson),
                    )
                    for i, lesson in enumerate(new_lessons)
                ]
            )

        if not new_lessons:
            return LessonPlan()

        # If no existing lessons, create all as new
        if not existing_lessons:
            return LessonPlan(
                creates=[
                    CreateInstruction(
                        new_lesson_index=i,
                        create_prompt=self._default_create_prompt(lesson),
                    )
                    for i, lesson in enumerate(new_lessons)
                ]
            )

        try:
            # Format the matching request
            match_request = self._format_match_request(new_lessons, existing_lessons)
            logger.debug(
                "[Lessons] Calling LLM to match {} new lesson(s) against {} existing",
                len(new_lessons),
                len(existing_lessons),
            )

            # Call LLM for matching
            response = await self._call_llm(MATCH_SYSTEM_PROMPT, match_request)
            logger.debug("[Lessons] LLM response for matching: {} chars", len(response))

            # Parse response
            plan = self._parse_match_response(response, new_lessons)
            logger.debug(
                "[Lessons] Parsed plan: {} merge(s), {} create(s)",
                len(plan.merges),
                len(plan.creates),
            )
            return plan

        except Exception as e:
            logger.warning("[Lessons] LLM matching failed, creating all as new: {}", e)
            return LessonPlan(
                creates=[
                    CreateInstruction(
                        new_lesson_index=i,
                        create_prompt=self._default_create_prompt(lesson),
                    )
                    for i, lesson in enumerate(new_lessons)
                ]
            )

    async def judge_lesson_usage(
        self,
        messages: list[Message],
        available_lessons: list[ExistingLessonSummary],
    ) -> list[LessonUsageResult]:
        """
        Judge which lessons were used in a trajectory and their effectiveness.

        Args:
            messages: Full message history from the step window.
            available_lessons: List of available lessons that could have been used.

        Returns:
            List of LessonUsageResult for lessons that were used.
        """
        if not self.llm:
            logger.debug("No LLM configured, skipping usage judgment")
            return []

        if not messages or not available_lessons:
            return []

        try:
            # Format the request
            request_text = self._format_usage_request(messages, available_lessons)
            logger.debug(
                "[Lessons] Calling LLM to judge usage of {} lesson(s)",
                len(available_lessons),
            )

            # Call LLM for judgment
            response = await self._call_llm(USAGE_JUDGE_SYSTEM_PROMPT, request_text)
            logger.debug("[Lessons] LLM response for usage judgment: {} chars", len(response))

            # Parse response
            results = self._parse_usage_response(response)
            used_lessons = [r for r in results if r.was_used]
            logger.debug(
                "[Lessons] {} lesson(s) were used: {}",
                len(used_lessons),
                [(r.lesson_id[:8], r.effectiveness) for r in used_lessons],
            )
            return results

        except Exception as e:
            logger.warning("[Lessons] LLM usage judgment failed: {}", e)
            return []

    async def rewrite_lesson_content(
        self,
        existing_symptom: str,
        existing_fix_workflow: list[str],
        existing_contraindications: list[str],
        existing_triggers: list[str],
        new_lesson: JudgmentResult,
    ) -> RewriteResult | None:
        """
        Rewrite/merge lesson content using LLM.

        Args:
            existing_symptom: Current symptom description.
            existing_fix_workflow: Current fix workflow steps.
            existing_contraindications: Current contraindications.
            existing_triggers: Current trigger signatures.
            new_lesson: New lesson to merge in.

        Returns:
            RewriteResult with merged content, or None if rewrite fails.
        """
        if not self.llm:
            logger.debug("No LLM configured, skipping rewrite")
            return None

        try:
            request_text = self._format_rewrite_request(
                existing_symptom,
                existing_fix_workflow,
                existing_contraindications,
                existing_triggers,
                new_lesson,
            )

            response = await self._call_llm(REWRITE_SYSTEM_PROMPT, request_text)
            return self._parse_rewrite_response(response)

        except Exception as e:
            logger.warning("LLM rewrite failed: {}", e)
            return None

    def _format_rewrite_request(
        self,
        existing_symptom: str,
        existing_fix_workflow: list[str],
        existing_contraindications: list[str],
        existing_triggers: list[str],
        new_lesson: JudgmentResult,
    ) -> str:
        """Format the rewrite request for LLM."""
        parts: list[str] = []

        parts.append("## Existing Lesson")
        parts.append("")
        parts.append(f"**Symptom:** {existing_symptom}")
        parts.append("")
        parts.append("**Fix Workflow:**")
        for i, step in enumerate(existing_fix_workflow):
            parts.append(f"{i + 1}. {step}")
        parts.append("")
        parts.append("**Contraindications:**")
        for contra in existing_contraindications:
            parts.append(f"- {contra}")
        if not existing_contraindications:
            parts.append("- None")
        parts.append("")
        parts.append(f"**Trigger Signatures:** {', '.join(existing_triggers)}")
        parts.append("")

        parts.append("## New Lesson to Merge")
        parts.append("")
        parts.append(f"**Symptom:** {new_lesson.symptom}")
        parts.append("")
        parts.append("**Fix Workflow:**")
        for i, step in enumerate(new_lesson.fix_workflow):
            parts.append(f"{i + 1}. {step}")
        parts.append("")
        parts.append("**Contraindications:**")
        for contra in new_lesson.contraindications or []:
            parts.append(f"- {contra}")
        if not new_lesson.contraindications:
            parts.append("- None")
        parts.append("")
        parts.append(f"**Trigger Signatures:** {', '.join(new_lesson.trigger_signatures)}")
        parts.append("")

        parts.append("## Task")
        parts.append("Merge these two lessons into a single, coherent lesson.")
        parts.append("Combine the best aspects of both while avoiding redundancy.")

        return "\n".join(parts)

    def _parse_rewrite_response(self, response: str) -> RewriteResult | None:
        """Parse LLM rewrite response."""
        try:
            response = self._clean_json_response(response)
            data: dict[str, Any] = json.loads(response)

            return RewriteResult(
                symptom=data.get("symptom", ""),
                fix_workflow=data.get("fix_workflow", []),
                contraindications=data.get("contraindications", []),
                trigger_signatures=data.get("trigger_signatures", []),
            )

        except json.JSONDecodeError as e:
            logger.warning("Failed to parse rewrite response as JSON: {}", e)
            return None

    def _format_usage_request(
        self,
        messages: list[Message],
        available_lessons: list[ExistingLessonSummary],
    ) -> str:
        """Format the usage judgment request for LLM."""
        parts: list[str] = []

        # Format trajectory
        parts.append("## Trajectory")
        parts.append("")
        for i, msg in enumerate(messages):
            role = msg.role.upper()
            content_text = self._extract_message_content(msg)

            tool_calls_text = ""
            if msg.tool_calls:
                tool_calls_text = "\n".join(
                    f"  [Tool Call] {tc.function.name}({tc.function.arguments or ''})"
                    for tc in msg.tool_calls
                )

            parts.append(f"### Message {i + 1} ({role})")
            if content_text:
                if len(content_text) > 2000:
                    content_text = content_text[:2000] + "\n... (truncated)"
                parts.append(content_text)
            if tool_calls_text:
                parts.append(tool_calls_text)
            parts.append("")

        # Format available lessons
        parts.append("## Available Lessons")
        parts.append("")
        for lesson in available_lessons:
            parts.append(f"### {lesson.name} (ID: {lesson.id})")
            parts.append(f"- Triggers: {', '.join(lesson.trigger_signatures)}")
            parts.append(f"- Symptom: {lesson.symptom}")
            parts.append(f"- Tags: {', '.join(lesson.tags)}")
            parts.append("")

        parts.append("## Task")
        parts.append("Analyze the trajectory and determine which lessons were used.")
        parts.append("For each used lesson, evaluate its effectiveness.")

        return "\n".join(parts)

    def _parse_usage_response(self, response: str) -> list[LessonUsageResult]:
        """Parse LLM usage judgment response."""
        try:
            response = self._clean_json_response(response)
            data: dict[str, Any] = json.loads(response)
            usages_data = data.get("usages", [])

            results: list[LessonUsageResult] = []
            for item in usages_data:
                try:
                    result = LessonUsageResult(
                        lesson_id=item.get("lesson_id", ""),
                        was_used=item.get("was_used", False),
                        use_count=item.get("use_count", 0),
                        was_helpful=item.get("was_helpful", False),
                        effectiveness=item.get("effectiveness", 0.0),
                        reason=item.get("reason", ""),
                    )
                    if result.was_used and result.lesson_id:
                        results.append(result)
                except Exception as e:
                    logger.warning("Failed to parse usage item: {}", e)
                    continue

            return results

        except json.JSONDecodeError as e:
            logger.warning("Failed to parse usage response as JSON: {}", e)
            return []

    def _format_trajectory(
        self,
        messages: list[Message],
        user_feedbacks: list[UserFeedback],
    ) -> str:
        """Format messages and feedbacks into a trajectory description."""
        parts: list[str] = []

        parts.append("## Trajectory")
        parts.append("")

        for i, msg in enumerate(messages):
            role = msg.role.upper()
            content_text = self._extract_message_content(msg)

            # Format tool calls if present
            tool_calls_text = ""
            if msg.tool_calls:
                tool_calls_text = "\n".join(
                    f"  [Tool Call] {tc.function.name}({tc.function.arguments or ''})"
                    for tc in msg.tool_calls
                )

            parts.append(f"### Message {i + 1} ({role})")
            if content_text:
                # Truncate very long content
                if len(content_text) > 2000:
                    content_text = content_text[:2000] + "\n... (truncated)"
                parts.append(content_text)
            if tool_calls_text:
                parts.append(tool_calls_text)
            parts.append("")

        # Add user feedbacks
        if user_feedbacks:
            parts.append("## User Feedbacks")
            parts.append("")
            for fb in user_feedbacks:
                parts.append(f"- **{fb.type.upper()}**: {fb.action}")
                if fb.reason:
                    parts.append(f"  Reason: {fb.reason}")
                if fb.context_summary:
                    parts.append(f"  Context: {fb.context_summary}")
            parts.append("")

        return "\n".join(parts)

    def _extract_message_content(self, msg: Message) -> str:
        """Extract text content from a message."""
        from kosong.message import TextPart, ThinkPart

        text_parts: list[str] = []
        for part in msg.content:
            if isinstance(part, TextPart):
                text_parts.append(part.text)
            elif isinstance(part, ThinkPart):
                # Include thinking for context but mark it
                text_parts.append(f"[Thinking] {part.think[:500]}")

        return "\n".join(text_parts)

    def _format_match_request(
        self,
        new_lessons: list[JudgmentResult],
        existing_lessons: list[ExistingLessonSummary],
    ) -> str:
        """Format the matching request for LLM."""
        parts: list[str] = []

        parts.append("## New Lessons to Match")
        parts.append("")
        for i, lesson in enumerate(new_lessons):
            parts.append(f"### New Lesson {i}")
            parts.append(f"- Name: {lesson.name}")
            parts.append(f"- Triggers: {', '.join(lesson.trigger_signatures)}")
            parts.append(f"- Symptom: {lesson.symptom}")
            parts.append(f"- Tags: {', '.join(lesson.tags or [])}")
            parts.append(f"- Fix Workflow: {'; '.join(lesson.fix_workflow)}")
            parts.append("")

        parts.append("## Existing Lessons")
        parts.append("")
        for lesson in existing_lessons:
            parts.append(f"### {lesson.name} (ID: {lesson.id})")
            parts.append(f"- Triggers: {', '.join(lesson.trigger_signatures)}")
            parts.append(f"- Symptom: {lesson.symptom}")
            parts.append(f"- Tags: {', '.join(lesson.tags)}")
            parts.append("")

        parts.append("## Task")
        parts.append("For each new lesson, decide whether to:")
        parts.append("1. MERGE into an existing lesson (if addressing the same problem)")
        parts.append("2. CREATE as a new lesson (if unique)")
        parts.append("")
        parts.append("Provide detailed prompts for each operation.")

        return "\n".join(parts)

    def _default_create_prompt(self, lesson: JudgmentResult) -> str:
        """Generate a default create prompt for a lesson."""
        return f"""Create a new lesson with the following details:

Name: {lesson.name}
Source: {lesson.source}

Trigger Signatures:
{chr(10).join(f"- {t}" for t in lesson.trigger_signatures)}

Symptom:
{lesson.symptom}

Fix Workflow:
{chr(10).join(f"{i + 1}. {step}" for i, step in enumerate(lesson.fix_workflow))}

Contraindications:
{chr(10).join(f"- {c}" for c in (lesson.contraindications or []))}

Evidence:
- Trajectory: {lesson.trajectory_summary}
- Fail Signal: {lesson.fail_signal or "N/A"}
- Pass Signal: {lesson.pass_signal or "N/A"}
- Verification: {lesson.verification or "N/A"}

Tags: {", ".join(lesson.tags or [])}
Confidence: {lesson.confidence}
Utility: {lesson.utility or 0.5}"""

    async def _call_llm(self, system_prompt: str, user_prompt: str) -> str:
        """Call the LLM with the given prompts."""
        if not self.llm:
            raise ValueError("LLM not configured")

        from kosong.message import Message, TextPart

        history = [Message(role="user", content=user_prompt)]

        streamed_message = await self.llm.chat_provider.generate(
            system_prompt=system_prompt,
            tools=[],
            history=history,
        )

        # Collect the full response
        text_parts: list[str] = []
        async for part in streamed_message:
            if isinstance(part, TextPart) and part.text:
                text_parts.append(part.text)

        return "".join(text_parts)

    def _parse_judgment_response(self, response: str) -> list[JudgmentResult]:
        """Parse LLM response into JudgmentResults."""
        try:
            response = self._clean_json_response(response)
            data: dict[str, Any] = json.loads(response)
            lessons_data = data.get("lessons", [])

            results: list[JudgmentResult] = []
            for item in lessons_data:
                try:
                    result = JudgmentResult(
                        should_save=item.get("should_save", False),
                        name=item.get("name", "unnamed-lesson"),
                        reason=item.get("reason", ""),
                        source=item.get("source", "env_feedback"),
                        trigger_signatures=item.get("trigger_signatures", []),
                        symptom=item.get("symptom", ""),
                        fix_workflow=item.get("fix_workflow", []),
                        contraindications=item.get("contraindications"),
                        trajectory_summary=item.get("trajectory_summary", ""),
                        fail_signal=item.get("fail_signal"),
                        pass_signal=item.get("pass_signal"),
                        verification=item.get("verification"),
                        confidence=item.get("confidence", 0.5),
                        utility=item.get("utility", 0.5),
                        tags=item.get("tags"),
                    )
                    results.append(result)
                except Exception as e:
                    logger.warning("Failed to parse lesson item: {}", e)
                    continue

            return results

        except json.JSONDecodeError as e:
            logger.warning("Failed to parse LLM response as JSON: {}", e)
            return []

    def _parse_match_response(
        self,
        response: str,
        new_lessons: list[JudgmentResult],
    ) -> LessonPlan:
        """Parse LLM matching response into a LessonPlan."""
        try:
            response = self._clean_json_response(response)
            data: dict[str, Any] = json.loads(response)

            merges: list[MergeInstruction] = []
            creates: list[CreateInstruction] = []

            # Parse merges
            for item in data.get("merges", []):
                try:
                    merges.append(
                        MergeInstruction(
                            new_lesson_index=item.get("new_lesson_index", 0),
                            existing_lesson_id=item.get("existing_lesson_id", ""),
                            merge_reason=item.get("merge_reason", ""),
                            rewrite_prompt=item.get("rewrite_prompt", ""),
                        )
                    )
                except Exception as e:
                    logger.warning("Failed to parse merge instruction: {}", e)

            # Parse creates
            for item in data.get("creates", []):
                try:
                    creates.append(
                        CreateInstruction(
                            new_lesson_index=item.get("new_lesson_index", 0),
                            create_prompt=item.get("create_prompt", ""),
                        )
                    )
                except Exception as e:
                    logger.warning("Failed to parse create instruction: {}", e)

            # Ensure all new lessons are accounted for
            handled_indices = {m.new_lesson_index for m in merges} | {
                c.new_lesson_index for c in creates
            }
            for i, lesson in enumerate(new_lessons):
                if i not in handled_indices:
                    creates.append(
                        CreateInstruction(
                            new_lesson_index=i,
                            create_prompt=self._default_create_prompt(lesson),
                        )
                    )

            return LessonPlan(merges=merges, creates=creates)

        except json.JSONDecodeError as e:
            logger.warning("Failed to parse match response as JSON: {}", e)
            # Fallback: create all as new
            return LessonPlan(
                creates=[
                    CreateInstruction(
                        new_lesson_index=i,
                        create_prompt=self._default_create_prompt(lesson),
                    )
                    for i, lesson in enumerate(new_lessons)
                ]
            )

    def _clean_json_response(self, response: str) -> str:
        """Clean up JSON response from LLM."""
        response = response.strip()

        # Handle markdown code blocks
        if response.startswith("```"):
            lines = response.split("\n")
            json_lines = [line for line in lines if not line.strip().startswith("```")]
            response = "\n".join(json_lines)

        return response
