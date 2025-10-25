import asyncio
import uuid
from enum import Enum
from typing import NamedTuple

from kosong.base.message import ContentPart, ToolCall, ToolCallPart
from kosong.tooling import ToolResult

from kimi_cli.soul import StatusSnapshot


class StepBegin(NamedTuple):
    n: int


class StepInterrupted:
    pass


class CompactionBegin:
    """
    Indicates that a compaction just began.
    This event must be sent during a step, which means, between `StepBegin` and `StepInterrupted`.
    And, there must be a `CompactionEnd` directly following this event.
    """

    pass


class CompactionEnd:
    """
    Indicates that a compaction just ended.
    This event must be sent directly after a `CompactionBegin` event.
    """

    pass


class StatusUpdate(NamedTuple):
    status: StatusSnapshot


type ControlFlowEvent = StepBegin | StepInterrupted | CompactionBegin | CompactionEnd | StatusUpdate
type Event = ControlFlowEvent | ContentPart | ToolCall | ToolCallPart | ToolResult


class ApprovalResponse(Enum):
    APPROVE = "approve"
    APPROVE_FOR_SESSION = "approve_for_session"
    REJECT = "reject"


class ApprovalRequest:
    def __init__(self, tool_call_id: str, sender: str, action: str, description: str):
        self.id = str(uuid.uuid4())
        self.tool_call_id = tool_call_id
        self.sender = sender
        self.action = action
        self.description = description
        self._future = asyncio.Future[ApprovalResponse]()

    def __repr__(self) -> str:
        return (
            f"ApprovalRequest(id={self.id}, tool_call_id={self.tool_call_id}, "
            f"sender={self.sender}, action={self.action}, description={self.description})"
        )

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


type WireMessage = Event | ApprovalRequest
