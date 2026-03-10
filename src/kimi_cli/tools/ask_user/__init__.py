from __future__ import annotations

import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import override
from uuid import uuid4

from kosong.tooling import BriefDisplayBlock, CallableTool2, Tool, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul import get_wire_or_none, wire_send
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import load_desc
from kimi_cli.wire.types import QuestionItem, QuestionNotSupported, QuestionOption, QuestionRequest

logger = logging.getLogger(__name__)

NAME = "AskUserQuestion"

_BASE_DESCRIPTION = load_desc(Path(__file__).parent / "description.md")

_PLAN_MODE_SUFFIX = (
    "\n\nPlan mode note: Use this tool ONLY to clarify requirements or choose between "
    'approaches. Do NOT ask about plan approval or reference "the plan" — '
    "the user cannot see the plan until you call ExitPlanMode."
)


class QuestionOptionParam(BaseModel):
    label: str = Field(
        description="Concise display text (1-5 words). If recommended, append '(Recommended)'."
    )
    description: str = Field(
        default="",
        description="Brief explanation of trade-offs or implications of choosing this option.",
    )


class QuestionParam(BaseModel):
    question: str = Field(description="A specific, actionable question. End with '?'.")
    header: str = Field(
        default="", description="Short category tag (max 12 chars, e.g. 'Auth', 'Style')."
    )
    options: list[QuestionOptionParam] = Field(
        description=(
            "2-4 meaningful, distinct options. Do NOT include an 'Other' option — "
            "the system adds one automatically."
        ),
        min_length=2,
        max_length=4,
    )
    multi_select: bool = Field(
        default=False,
        description="Whether the user can select multiple options.",
    )


class Params(BaseModel):
    questions: list[QuestionParam] = Field(
        description="The questions to ask the user (1-4 questions).",
        min_length=1,
        max_length=4,
    )


class AskUserQuestion(CallableTool2[Params]):
    name: str = NAME
    description: str = _BASE_DESCRIPTION
    params: type[Params] = Params

    def __init__(self) -> None:
        super().__init__()
        self._plan_mode_checker: Callable[[], bool] | None = None
        self._cached_plan_mode: bool | None = None

    def bind_plan_mode(self, plan_mode_checker: Callable[[], bool]) -> None:
        """Late-bind plan mode checker after KimiSoul is constructed."""
        self._plan_mode_checker = plan_mode_checker

    @property
    def base(self) -> Tool:
        """Dynamically append plan mode note when plan mode is active."""
        if self._plan_mode_checker is not None:
            in_plan = self._plan_mode_checker()
            if in_plan != self._cached_plan_mode:
                self._cached_plan_mode = in_plan
                desc = _BASE_DESCRIPTION + _PLAN_MODE_SUFFIX if in_plan else _BASE_DESCRIPTION
                self._base = Tool(
                    name=self._base.name,
                    description=desc,
                    parameters=self._base.parameters,
                )
        return self._base

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        wire = get_wire_or_none()
        if wire is None:
            return ToolError(
                message="Cannot ask user questions: Wire is not available.",
                brief="Wire unavailable",
            )

        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            return ToolError(
                message="AskUserQuestion must be called from a tool call context.",
                brief="Invalid context",
            )

        questions = [
            QuestionItem(
                question=q.question,
                header=q.header,
                options=[
                    QuestionOption(label=o.label, description=o.description) for o in q.options
                ],
                multi_select=q.multi_select,
            )
            for q in params.questions
        ]

        request = QuestionRequest(
            id=str(uuid4()),
            tool_call_id=tool_call.id,
            questions=questions,
        )

        wire_send(request)

        try:
            answers = await request.wait()
        except QuestionNotSupported:
            return ToolError(
                message=(
                    "The connected client does not support interactive questions. "
                    "Do NOT call this tool again. "
                    "Ask the user directly in your text response instead."
                ),
                brief="Client unsupported",
            )
        except Exception:
            logger.exception("Failed to get user response for question %s", request.id)
            return ToolError(
                message="Failed to get user response.",
                brief="Question failed",
            )

        if not answers:
            return ToolReturnValue(
                is_error=False,
                output='{"answers": {}, "note": "User dismissed the question without answering."}',
                message="User dismissed the question without answering.",
                display=[BriefDisplayBlock(text="User dismissed")],
            )

        formatted = json.dumps({"answers": answers}, ensure_ascii=False)
        return ToolReturnValue(
            is_error=False,
            output=formatted,
            message="User has answered.",
            display=[BriefDisplayBlock(text="User answered")],
        )
