"""ExitPlanMode tool — lets the LLM submit a plan for user approval."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import override
from uuid import uuid4

from kosong.tooling import BriefDisplayBlock, CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field, field_validator

from kimi_cli.soul import get_wire_or_none, wire_send
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import ToolRejectedError, load_desc
from kimi_cli.wire.types import (
    PlanDisplay,
    QuestionItem,
    QuestionNotSupported,
    QuestionOption,
    QuestionRequest,
)

logger = logging.getLogger(__name__)

NAME = "ExitPlanMode"

_RESERVED_LABELS = {"reject", "revise", "approve", "reject and exit"}


class PlanOption(BaseModel):
    """A selectable approach/option within the plan."""

    label: str = Field(
        description=(
            "Short name for this option (1-8 words). "
            "Append '(Recommended)' if you recommend this option."
        ),
    )
    description: str = Field(
        default="",
        description="Brief summary of this approach and its trade-offs.",
    )

    @field_validator("label")
    @classmethod
    def label_not_reserved(cls, v: str) -> str:
        if v.strip().lower() in _RESERVED_LABELS:
            reserved = ", ".join(f"'{w.title()}'" for w in sorted(_RESERVED_LABELS))
            raise ValueError(
                f"Option label {v!r} is reserved. Do not use {reserved} as option labels."
            )
        return v


class Params(BaseModel):
    options: list[PlanOption] | None = Field(
        default=None,
        max_length=3,
        description=(
            "When the plan contains multiple alternative approaches, list them here "
            "so the user can choose which one to execute. 2-3 options. "
            "Each option represents a distinct approach from the plan. "
            "Do not use 'Reject', 'Revise', 'Approve', or 'Reject and Exit' as labels."
        ),
    )

    @field_validator("options")
    @classmethod
    def options_labels_unique(cls, v: list[PlanOption] | None) -> list[PlanOption] | None:
        if v is None:
            return v
        labels = [opt.label for opt in v]
        if len(labels) != len(set(labels)):
            raise ValueError("Option labels must be unique. Found duplicate label(s).")
        return v


class ExitPlanMode(CallableTool2[Params]):
    name: str = NAME
    description: str = load_desc(Path(__file__).parent / "description.md")
    params: type[Params] = Params

    def __init__(self) -> None:
        super().__init__()
        self._toggle_callback: Callable[[], Awaitable[bool]] | None = None
        self._plan_file_path_getter: Callable[[], Path | None] | None = None
        self._plan_mode_checker: Callable[[], bool] | None = None
        self._should_auto_approve_exit: Callable[[], bool] | None = None

    def bind(
        self,
        toggle_callback: Callable[[], Awaitable[bool]],
        plan_file_path_getter: Callable[[], Path | None],
        plan_mode_checker: Callable[[], bool],
        should_auto_approve_exit: Callable[[], bool] | None = None,
    ) -> None:
        """Late-bind soul callbacks after KimiSoul is constructed."""
        self._toggle_callback = toggle_callback
        self._plan_file_path_getter = plan_file_path_getter
        self._plan_mode_checker = plan_mode_checker
        self._should_auto_approve_exit = should_auto_approve_exit

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        # Guard: only works in plan mode
        if not self._plan_mode_checker or not self._plan_mode_checker():
            return ToolError(
                message="Not in plan mode. ExitPlanMode is only available during plan mode.",
                brief="Not in plan mode",
            )

        if not self._toggle_callback or not self._plan_file_path_getter:
            return ToolError(
                message="ExitPlanMode is not properly initialized.",
                brief="Not initialized",
            )

        # Read the plan file
        plan_path = self._plan_file_path_getter()
        plan_content: str | None = None
        if plan_path and await asyncio.to_thread(plan_path.exists):
            plan_content = await asyncio.to_thread(plan_path.read_text, encoding="utf-8")

        if not plan_content:
            return ToolError(
                message=f"No plan file found. Write your plan to {plan_path} first, "
                "then call ExitPlanMode.",
                brief="No plan file",
            )

        # Auto-approve plan approval only when no user is present (afk).
        if self._should_auto_approve_exit and self._should_auto_approve_exit():
            await self._toggle_callback()
            return ToolReturnValue(
                is_error=False,
                output=(
                    f"Plan approved (auto-approved). "
                    f"Plan mode deactivated. All tools are now available.\n"
                    f"Plan saved to: {plan_path}\n\n"
                    f"## Approved Plan:\n{plan_content}"
                ),
                message="Plan approved (auto)",
                display=[BriefDisplayBlock(text="Plan approved (auto)")],
            )

        # Present plan to user via QuestionRequest
        wire = get_wire_or_none()
        if wire is None:
            return ToolError(
                message="Cannot present plan: Wire is not available.",
                brief="Wire unavailable",
            )

        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            return ToolError(
                message="ExitPlanMode must be called from a tool call context.",
                brief="Invalid context",
            )

        has_options = params.options is not None and len(params.options) >= 2

        _reject_options = [
            QuestionOption(
                label="Reject",
                description="Reject and stay in plan mode",
            ),
            QuestionOption(
                label="Reject and Exit",
                description="Reject and exit plan mode",
            ),
        ]

        if has_options:
            assert params.options is not None
            question_options = [
                QuestionOption(label=opt.label, description=opt.description)
                for opt in params.options
            ]
            question_options.extend(_reject_options)
        else:
            question_options = [
                QuestionOption(
                    label="Approve",
                    description="Exit plan mode and start execution",
                ),
                *_reject_options,
            ]

        # Display plan content inline in the chat
        wire_send(PlanDisplay(content=plan_content, file_path=str(plan_path)))

        request = QuestionRequest(
            id=str(uuid4()),
            tool_call_id=tool_call.id,
            questions=[
                QuestionItem(
                    question="Approve this plan",
                    header="Plan",
                    options=question_options,
                    other_label="Revise",
                    other_description="Stay in plan mode and provide feedback",
                )
            ],
        )

        wire_send(request)

        try:
            answers = await request.wait()
        except QuestionNotSupported:
            return ToolError(
                message="The connected client does not support plan mode. "
                "Do NOT call this tool again.",
                brief="Client unsupported",
            )
        except Exception:
            logger.exception("Failed to get user response for ExitPlanMode")
            return ToolError(
                message="Failed to get user response.",
                brief="Question failed",
            )

        if not answers:
            return ToolReturnValue(
                is_error=False,
                output="User dismissed without choosing. Plan mode remains active. "
                "Continue working on your plan or call ExitPlanMode again when ready.",
                message="Dismissed",
                display=[BriefDisplayBlock(text="Dismissed")],
            )

        # Parse user choice — exact match on option label
        chose_reject_and_exit = any(v == "Reject and Exit" for v in answers.values())

        if chose_reject_and_exit:
            await self._toggle_callback()
            return ToolRejectedError(
                message=(
                    "Plan rejected by user. Plan mode deactivated. "
                    "All tools are now available. "
                    "Wait for the user's next message."
                ),
                brief="Plan rejected, exited plan mode",
            )

        chose_reject = any(v == "Reject" for v in answers.values())

        if chose_reject:
            return ToolRejectedError(
                message=(
                    "Plan rejected by user. Stay in plan mode. "
                    "The user will provide feedback via conversation. "
                    "Wait for the user's next message before revising."
                ),
                brief="Plan rejected",
            )

        # Approve — multi-approach (user selected a specific option)
        if has_options:
            assert params.options is not None
            option_labels = {opt.label for opt in params.options}
            chosen_option = None
            for v in answers.values():
                if v in option_labels:
                    chosen_option = v
                    break

            if chosen_option:
                await self._toggle_callback()
                return ToolReturnValue(
                    is_error=False,
                    output=(
                        f'Plan approved by user. Selected approach: "{chosen_option}"\n'
                        f"Plan mode deactivated. All tools are now available.\n"
                        f"Plan saved to: {plan_path}\n\n"
                        f'IMPORTANT: Execute ONLY the selected approach "{chosen_option}". '
                        f"Ignore other approaches in the plan.\n\n"
                        f"## Approved Plan:\n{plan_content}"
                    ),
                    message=f"Plan approved: {chosen_option}",
                    display=[BriefDisplayBlock(text=f"Plan approved: {chosen_option}")],
                )

        # Approve — single-approach only (has_options uses option labels, not "Approve")
        chose_approve = not has_options and any(v == "Approve" for v in answers.values())
        if chose_approve:
            await self._toggle_callback()
            return ToolReturnValue(
                is_error=False,
                output=(
                    f"Plan approved by user. Plan mode deactivated. "
                    f"All tools are now available.\n"
                    f"Plan saved to: {plan_path}\n\n"
                    f"## Approved Plan:\n{plan_content}"
                ),
                message="Plan approved",
                display=[BriefDisplayBlock(text="Plan approved")],
            )

        # Revise — user selected the free-text "Revise" option (fallback)
        feedback = ""
        for v in answers.values():
            if v not in ("Approve", "Reject", "Reject and Exit"):
                feedback = v
        if feedback:
            msg = (
                "User wants to revise the plan. Stay in plan mode. "
                "Revise based on the feedback below.\n\n"
                f"User feedback: {feedback}"
            )
        else:
            msg = (
                "User wants to revise the plan. Stay in plan mode. "
                "Wait for the user's next message with feedback before revising."
            )
        return ToolReturnValue(
            is_error=False,
            output=msg,
            message="Plan revision requested",
            display=[BriefDisplayBlock(text="Plan revision requested")],
        )
