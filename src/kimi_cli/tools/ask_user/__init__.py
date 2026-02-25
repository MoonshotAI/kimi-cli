from __future__ import annotations

import json
from pathlib import Path
from typing import override
from uuid import uuid4

from kosong.tooling import BriefDisplayBlock, CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul import get_wire_or_none, wire_send
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import load_desc
from kimi_cli.wire.types import QuestionItem, QuestionOption, QuestionRequest

NAME = "AskUserQuestion"


class QuestionOptionParam(BaseModel):
    label: str = Field(description="The display text for this option (1-5 words).")
    description: str = Field(default="", description="Explanation of what this option means.")


class QuestionParam(BaseModel):
    question: str = Field(description="The complete question to ask the user.")
    header: str = Field(default="", description="Short label displayed as a tag (max 12 chars).")
    options: list[QuestionOptionParam] = Field(
        description="The available choices (2-4 options).",
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
    description: str = load_desc(Path(__file__).parent / "description.md")
    params: type[Params] = Params

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
        except Exception:
            return ToolError(
                message="Failed to get user response.",
                brief="Question failed",
            )

        formatted = json.dumps({"answers": answers}, ensure_ascii=False)
        return ToolReturnValue(
            is_error=False,
            output=formatted,
            message="User has answered.",
            display=[BriefDisplayBlock(text="User answered")],
        )
