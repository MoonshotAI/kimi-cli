"""Goal management tool for long-running tasks."""

import time
from pathlib import Path
from typing import Literal, override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.utils import load_desc
from kimi_cli.telemetry import track
from kimi_cli.utils.logging import logger


class Params(BaseModel):
    status: Literal["complete"] = Field(
        description='Set the goal status. Only "complete" is supported.',
    )


class UpdateGoal(CallableTool2[Params]):
    name: str = "UpdateGoal"
    description: str = load_desc(Path(__file__).parent / "update_goal.md")
    params: type[Params] = Params

    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self._runtime = runtime

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        goal = self._runtime.session.state.goal
        if goal is None:
            return ToolError(
                message="No active goal. Use /goal <objective> to set one.",
                brief="No active goal.",
            )

        if params.status == "complete":
            if goal.status == "complete":
                return ToolOk(
                    output="Goal is already marked as complete.",
                    message="Goal already complete.",
                    brief="Goal already complete.",
                )

            goal.status = "complete"
            goal.updated_at = time.time()
            self._runtime.session.save_state()

            duration_s = goal.updated_at - goal.created_at if goal.created_at else 0.0
            track("goal_completed", tokens_used=goal.tokens_used, duration_s=round(duration_s, 1))
            logger.info(
                "Goal completed: objective={objective}, tokens_used={tokens}, duration_s={duration}",
                objective=goal.objective[:50],
                tokens=goal.tokens_used,
                duration=round(duration_s, 1),
            )

            result_msg = "Goal marked as complete."
            if goal.token_budget is not None:
                remaining = max(0, goal.token_budget - goal.tokens_used)
                result_msg += f" Tokens used: {goal.tokens_used} / {goal.token_budget} (remaining: {remaining})."
            else:
                result_msg += f" Tokens used: {goal.tokens_used}."

            return ToolOk(
                output=result_msg,
                message="Goal complete.",
                brief="Goal marked as complete.",
            )

        return ToolError(
            message=f'Unsupported status: "{params.status}". Only "complete" is allowed.',
            brief="Invalid status.",
        )
