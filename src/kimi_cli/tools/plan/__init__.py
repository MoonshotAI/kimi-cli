"""ExitPlanMode tool — lets the LLM submit a plan for user approval."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import override
from uuid import uuid4

from kosong.tooling import BriefDisplayBlock, CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel

from kimi_cli.soul import get_wire_or_none, wire_send
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import ToolRejectedError, load_desc
from kimi_cli.wire.types import QuestionItem, QuestionNotSupported, QuestionOption, QuestionRequest

logger = logging.getLogger(__name__)

NAME = "ExitPlanMode"


class Params(BaseModel):
    pass


class ExitPlanMode(CallableTool2[Params]):
    name: str = NAME
    description: str = load_desc(Path(__file__).parent / "description.md")
    params: type[Params] = Params

    def __init__(self) -> None:
        super().__init__()
        self._toggle_callback: Callable[[], Awaitable[bool]] | None = None
        self._plan_file_path_getter: Callable[[], Path | None] | None = None
        self._plan_mode_checker: Callable[[], bool] | None = None

    def bind(
        self,
        toggle_callback: Callable[[], Awaitable[bool]],
        plan_file_path_getter: Callable[[], Path | None],
        plan_mode_checker: Callable[[], bool],
    ) -> None:
        """Late-bind soul callbacks after KimiSoul is constructed."""
        self._toggle_callback = toggle_callback
        self._plan_file_path_getter = plan_file_path_getter
        self._plan_mode_checker = plan_mode_checker

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

        request = QuestionRequest(
            id=str(uuid4()),
            tool_call_id=tool_call.id,
            questions=[
                QuestionItem(
                    question=f"Plan ready for review (saved at {plan_path}):",
                    header="Plan",
                    body=plan_content,
                    options=[
                        QuestionOption(
                            label="Approve",
                            description="Exit plan mode and start execution",
                        ),
                        QuestionOption(
                            label="Reject",
                            description="Stay in plan mode and continue conversation",
                        ),
                    ],
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
        chose_approve = any(v == "Approve" for v in answers.values())
        chose_reject = any(v == "Reject" for v in answers.values())

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
        elif chose_reject:
            return ToolRejectedError(
                message=(
                    "Plan rejected by user. Stay in plan mode. "
                    "The user will provide feedback via conversation. "
                    "Wait for the user's next message before revising."
                ),
                brief="Plan rejected",
            )
        else:
            # Revise — extract feedback text
            feedback = ""
            for v in answers.values():
                if v not in ("Approve", "Reject"):
                    feedback = v

            msg = (
                "Plan needs revision. Please revise your plan based on "
                "feedback and call ExitPlanMode again."
            )
            if feedback:
                msg += f"\n\nUser feedback: {feedback}"
            return ToolReturnValue(
                is_error=False,
                output=msg,
                message="Plan revised",
                display=[BriefDisplayBlock(text="Plan revised")],
            )
