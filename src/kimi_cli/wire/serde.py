from __future__ import annotations

from typing import Any

from kosong.utils.typing import JsonType
from pydantic import BaseModel, ConfigDict

from kimi_cli.wire.message import WireMessage, WireMessageEnvelope


def serialize_wire_message(msg: WireMessage) -> dict[str, JsonType]:
    """
    Convert a `WireMessage` into a jsonifiable dict.
    """
    envelope = WireMessageEnvelope.from_wire_message(msg)
    return envelope.model_dump(mode="json")


def deserialize_wire_message(data: dict[str, JsonType] | Any) -> WireMessage:
    """
    Convert a jsonifiable dict into a `WireMessage`.

    Raises:
        ValueError: If the message type is unknown or the payload is invalid.
    """
    envelope = WireMessageEnvelope.model_validate(data)
    return envelope.to_wire_message()


class WireMessageRecord(BaseModel):
    """
    The persisted record of a `WireMessage`.
    """

    model_config = ConfigDict(extra="ignore")

    timestamp: float
    message: WireMessageEnvelope

    @classmethod
    def from_wire_message(cls, msg: WireMessage, *, timestamp: float) -> WireMessageRecord:
        return cls(timestamp=timestamp, message=WireMessageEnvelope.from_wire_message(msg))

    def to_wire_message(self) -> WireMessage:
        return self.message.to_wire_message()
