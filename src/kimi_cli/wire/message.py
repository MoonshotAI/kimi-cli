from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence
from enum import Enum
from typing import Any

from kosong.message import ContentPart, ToolCall, ToolCallPart
from kosong.tooling import ToolOk, ToolResult
from pydantic import BaseModel, Field

from kimi_cli.soul import StatusSnapshot


class StepBegin(BaseModel):
    """
    Indicates the beginning of a new agent step.
    This event must be sent before any other event in the step.
    """

    n: int
    """The step number."""


class StepInterrupted(BaseModel):
    """Indicates the current step was interrupted, either by user intervention or an error."""

    pass


class CompactionBegin(BaseModel):
    """
    Indicates that a compaction just began.
    This event must be sent during a step, which means, between `StepBegin` and the next
    `StepBegin` or `StepInterrupted`. And, there must be a `CompactionEnd` directly following
    this event.
    """

    pass


class CompactionEnd(BaseModel):
    """
    Indicates that a compaction just ended.
    This event must be sent directly after a `CompactionBegin` event.
    """

    pass


class StatusUpdate(BaseModel):
    status: StatusSnapshot
    """The snapshot of the current soul status."""


class SubagentEvent(BaseModel):
    task_tool_call_id: str
    """The ID of the task tool call associated with this subagent."""
    event: Event
    """The event from the subagent."""


type ControlFlowEvent = StepBegin | StepInterrupted | CompactionBegin | CompactionEnd | StatusUpdate
"""Any control flow event."""
type Event = ControlFlowEvent | ContentPart | ToolCall | ToolCallPart | ToolResult | SubagentEvent
"""Any event, including control flow and content/tooling events."""


class ApprovalResponse(Enum):
    APPROVE = "approve"
    APPROVE_FOR_SESSION = "approve_for_session"
    REJECT = "reject"


class ApprovalRequest(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    tool_call_id: str
    sender: str
    action: str
    description: str

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._future = asyncio.Future[ApprovalResponse]()

    async def wait(self) -> ApprovalResponse:
        """
        Wait for the request to be resolved or cancelled.

        Returns:
            ApprovalResponse: The response to the approval request.
        """
        return await self._future

    def resolve(self, response: ApprovalResponse) -> None:
        """
        Resolve the approval request with the given response.
        This will cause the `wait()` method to return the response.
        """
        self._future.set_result(response)

    @property
    def resolved(self) -> bool:
        """Whether the request is resolved."""
        return self._future.done()


def serialize_event(event: Event) -> dict[str, Any]:
    """
    Convert an event message into a JSON-serializable dictionary.
    """
    match event:
        case StepBegin():
            return {"type": "step_begin", "payload": {"n": event.n}}
        case StepInterrupted():
            return {"type": "step_interrupted"}
        case CompactionBegin():
            return {"type": "compaction_begin"}
        case CompactionEnd():
            return {"type": "compaction_end"}
        case StatusUpdate():
            return {
                "type": "status_update",
                "payload": {"context_usage": event.status.context_usage},
            }
        case ContentPart():
            return {
                "type": "content_part",
                "payload": event.model_dump(mode="json", exclude_none=True),
            }
        case ToolCall():
            return {
                "type": "tool_call",
                "payload": event.model_dump(mode="json", exclude_none=True),
            }
        case ToolCallPart():
            return {
                "type": "tool_call_part",
                "payload": event.model_dump(mode="json", exclude_none=True),
            }
        case ToolResult():
            return {
                "type": "tool_result",
                "payload": serialize_tool_result(event),
            }
        case SubagentEvent():
            return {
                "type": "subagent_event",
                "payload": {
                    "task_tool_call_id": event.task_tool_call_id,
                    "event": serialize_event(event.event),
                },
            }


def serialize_approval_request(request: ApprovalRequest) -> dict[str, Any]:
    """
    Convert an ApprovalRequest into a JSON-serializable dictionary.
    """
    return {
        "id": request.id,
        "tool_call_id": request.tool_call_id,
        "sender": request.sender,
        "action": request.action,
        "description": request.description,
    }


def serialize_tool_result(result: ToolResult) -> dict[str, Any]:
    if isinstance(result.result, ToolOk):
        ok = True
        result_data = {
            "output": _serialize_tool_output(result.result.output),
            "message": result.result.message,
            "brief": result.result.brief,
        }
    else:
        ok = False
        result_data = {
            "output": result.result.output,
            "message": result.result.message,
            "brief": result.result.brief,
        }
    return {
        "tool_call_id": result.tool_call_id,
        "ok": ok,
        "result": result_data,
    }


def _serialize_tool_output(
    output: str | ContentPart | Sequence[ContentPart],
) -> str | list[Any] | dict[str, Any]:
    if isinstance(output, str):
        return output
    elif isinstance(output, ContentPart):
        return output.model_dump(mode="json", exclude_none=True)
    else:  # Sequence[ContentPart]
        return [part.model_dump(mode="json", exclude_none=True) for part in output]
