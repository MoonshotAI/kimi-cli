from __future__ import annotations

from typing import Any, Literal

from kosong.message import ContentPart
from kosong.utils.typing import JsonType
from pydantic import (
    BaseModel,
    ConfigDict,
    TypeAdapter,
    field_serializer,
    field_validator,
    model_serializer,
)

from kimi_cli.wire.message import ApprovalRequestResolved, Event, Request, is_event, is_request
from kimi_cli.wire.serde import serialize_wire_message


class _MessageBase(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"

    model_config = ConfigDict(extra="forbid")


class JSONRPCEventMessage(_MessageBase):
    method: Literal["event"] = "event"
    params: Event

    @field_serializer("params")
    def _serialize_params(self, params: Event) -> dict[str, JsonType]:
        return serialize_wire_message(params)

    @field_validator("params", mode="before")
    @classmethod
    def _validate_params(cls, value: Any) -> Event:
        if is_event(value):
            return value
        raise NotImplementedError("Event message deserialization is not implemented.")


class JSONRPCRequestMessage(_MessageBase):
    method: Literal["request"] = "request"
    id: str
    params: Request

    @field_serializer("params")
    def _serialize_params(self, params: Request) -> dict[str, JsonType]:
        return serialize_wire_message(params)

    @field_validator("params", mode="before")
    @classmethod
    def _validate_params(cls, value: Any) -> Request:
        if is_request(value):
            return value
        raise NotImplementedError("Event message deserialization is not implemented.")


class JSONRPCPromptMessage(_MessageBase):
    class Params(BaseModel):
        user_input: str | list[ContentPart]

    method: Literal["prompt"] = "prompt"
    id: str
    params: Params

    @model_serializer()
    def _serialize(self) -> dict[str, Any]:
        raise NotImplementedError("Prompt message serialization is not implemented.")


class JSONRPCCancelMessage(_MessageBase):
    method: Literal["cancel"] = "cancel"
    id: str

    @model_serializer()
    def _serialize(self) -> dict[str, Any]:
        raise NotImplementedError("Interrupt message serialization is not implemented.")


class _ResponseBase(_MessageBase):
    id: str


class JSONRPCSuccessResponse(_ResponseBase):
    result: JsonType


class JSONRPCErrorObject(BaseModel):
    code: int
    message: str
    data: JsonType | None = None


class JSONRPCErrorResponse(_ResponseBase):
    error: JSONRPCErrorObject


class JSONRPCApprovalRequestResult(ApprovalRequestResolved):
    """The `JSONRPCSuccessResponse.result` field should be able to be parsed into this type."""

    pass


type JSONRPCInMessage = (
    JSONRPCPromptMessage | JSONRPCCancelMessage | JSONRPCSuccessResponse | JSONRPCErrorResponse
)
JSONRPCInMessageAdapter = TypeAdapter[JSONRPCInMessage](JSONRPCInMessage)

type JSONRPCOutMessage = (
    JSONRPCEventMessage | JSONRPCRequestMessage | JSONRPCSuccessResponse | JSONRPCErrorResponse
)
