from __future__ import annotations

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field


class Params(BaseModel):
    query: str = Field(description="The search query to look for in archived conversation history.")


class ArchiveSearch(CallableTool2[Params]):
    name = "ArchiveSearch"
    description = (
        "Search the session's archived conversation history for relevant context. "
        "When the conversation grows beyond the API's payload limit, older messages are "
        "summarized and stored in a local archive. This tool lets you retrieve that "
        "context when you need it."
    )
    params = Params

    async def __call__(self, params: Params) -> ToolReturnValue:
        return ToolOk(
            output="",
            message="No archived context is available for this session.",
        )
