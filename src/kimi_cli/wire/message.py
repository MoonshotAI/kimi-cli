from __future__ import annotations

import asyncio
import uuid
from enum import Enum
from typing import Any, cast

from kosong.message import ContentPart, ToolCall, ToolCallPart
from kosong.tooling import ToolResult
from kosong.utils.typing import JsonType
from pydantic import BaseModel, Field, field_serializer, field_validator

from kimi_cli.utils.typing import flatten_union


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
    """
    An update on the current status of the soul.
    None fields indicate no change from the previous status.
    """

    context_usage: float | None
    """The usage of the context, in percentage."""


class SubagentEvent(BaseModel):
    task_tool_call_id: str
    """The ID of the task tool call associated with this subagent."""
    event: Event
    """The event from the subagent."""

    @field_serializer("event", when_used="json")
    def _serialize_event(self, event: Event) -> dict[str, Any]:
        envelope = WireMessageEnvelope.from_wire_message(event)
        return envelope.model_dump(mode="json")

    @field_validator("event", mode="before")
    @classmethod
    def _validate_event(cls, value: Any) -> Event:
        if is_wire_message(value):
            if is_event(value):
                return value
            raise ValueError("SubagentEvent event must be an Event")

        if not isinstance(value, dict):
            raise ValueError("SubagentEvent event must be a dict")
        event_type = cast(dict[str, Any], value).get("type")
        event_payload = cast(dict[str, Any], value).get("payload")
        envelope = WireMessageEnvelope.model_validate(
            {"type": event_type, "payload": event_payload}
        )
        event = envelope.to_wire_message()
        if not is_event(event):
            raise ValueError("SubagentEvent event must be an Event")
        return cast(Event, event)


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


type Request = ApprovalRequest
"""Any request. Request is a message that expects a response."""

type WireMessage = Event | Request
"""Any message sent over the `Wire`."""


_EVENT_TYPES: tuple[type[Event]] = flatten_union(Event)
_REQUEST_TYPES: tuple[type[Request]] = flatten_union(Request)
_WIRE_MESSAGE_TYPES: tuple[type[WireMessage]] = flatten_union(WireMessage)


def is_event(msg: Any) -> bool:
    """Check if the message is an Event."""
    return isinstance(msg, _EVENT_TYPES)


def is_request(msg: Any) -> bool:
    """Check if the message is a Request."""
    return isinstance(msg, _REQUEST_TYPES)


def is_wire_message(msg: Any) -> bool:
    """Check if the message is a WireMessage."""
    return isinstance(msg, _WIRE_MESSAGE_TYPES)


_NAME_TO_WIRE_MESSAGE_TYPE: dict[str, type[WireMessage]] = {
    cls.__name__: cls for cls in _WIRE_MESSAGE_TYPES
}


class WireMessageEnvelope(BaseModel):
    type: str
    payload: dict[str, JsonType]

    @classmethod
    def from_wire_message(cls, msg: WireMessage) -> WireMessageEnvelope:
        typename: str | None = None
        for name, typ in _NAME_TO_WIRE_MESSAGE_TYPE.items():
            if issubclass(type(msg), typ):
                typename = name
                break
        assert typename is not None, f"Unknown wire message type: {type(msg)}"
        return cls(
            type=typename,
            payload=msg.model_dump(mode="json"),
        )

    def to_wire_message(self) -> WireMessage:
        """
        Convert the envelope back into a `WireMessage`.

        Raises:
            ValueError: If the message type is unknown or the payload is invalid.
        """
        msg_type = _NAME_TO_WIRE_MESSAGE_TYPE.get(self.type)
        if msg_type is None:
            raise ValueError(f"Unknown wire message type: {self.type}")
        return msg_type.model_validate(self.payload)
