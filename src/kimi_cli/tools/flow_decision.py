from __future__ import annotations

from typing import Literal

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field


class Params(BaseModel):
    choice: Literal["CONTINUE", "STOP", "PAUSE"] = Field(
        description="The flow control choice: CONTINUE, STOP, or PAUSE."
    )
    confidence: float = Field(
        description="Confidence level from 0.0 to 1.0.",
        ge=0.0,
        le=1.0,
    )
    reasoning: str = Field(
        description="Brief reasoning for the decision.",
    )


class FlowDecisionTool(CallableTool2[Params]):
    name = "flow_decision"
    description = (
        "Make a flow control decision. Use this tool to choose the next step in an "
        "automated iteration loop. Options: CONTINUE (keep working), STOP (finish and return), "
        "PAUSE (suspend and allow user interjection)."
    )
    params = Params

    async def __call__(self, params: Params) -> ToolReturnValue:
        return ToolOk(output=f"Flow decision recorded: {params.choice}.")
