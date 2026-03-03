from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field


class AccCompactParams(BaseModel):
    task_summary: str = Field(
        description=(
            "Summary of current task and progress. Include what has been completed, "
            "what remains, and next step after compaction."
        )
    )


class AccCompactContextTool(CallableTool2[AccCompactParams]):
    name: str = "AccCompactContext"
    description: str = (
        "Compact the conversation context when ACC mode is enabled. "
        "Use this when context is getting large but only after you provide a clear "
        "task summary for post-compaction continuity."
    )
    params: type[AccCompactParams] = AccCompactParams

    def __init__(
        self,
        *,
        is_acc_enabled: Callable[[], bool],
        compact_context: Callable[[str], Awaitable[None]],
    ) -> None:
        super().__init__()
        self._is_acc_enabled = is_acc_enabled
        self._compact_context = compact_context

    @override
    async def __call__(self, params: AccCompactParams) -> ToolReturnValue:
        if not self._is_acc_enabled():
            return ToolError(
                message="ACC mode is disabled. Ask the user to enable it with /acc first.",
                brief="ACC mode disabled",
            )

        summary = params.task_summary.strip()
        if not summary:
            return ToolError(
                message="task_summary cannot be empty.",
                brief="Invalid task summary",
            )

        await self._compact_context(summary)
        return ToolOk(output="", message="Context compacted successfully.")
