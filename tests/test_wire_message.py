import inspect

import pytest
from inline_snapshot import snapshot
from pydantic import BaseModel

from kimi_cli.wire.serde import WireMessageRecord, deserialize_wire_message, serialize_wire_message
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BriefDisplayBlock,
    CompactionBegin,
    CompactionEnd,
    ImageURLPart,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    SubagentEvent,
    TextPart,
    ToolCall,
    ToolCallPart,
    ToolCallRequest,
    ToolResult,
    ToolReturnValue,
    TurnBegin,
    WireMessage,
    WireMessageEnvelope,
    is_event,
    is_request,
    is_wire_message,
)


def _test_serde(msg: WireMessage):
    serialized = serialize_wire_message(msg)
    deserialized = deserialize_wire_message(serialized)
    assert deserialized == msg


async def test_wire_message_serde():
    """Test serialization of all WireMessage types."""

    msg = TurnBegin(user_input="Hello, world!")
    assert serialize_wire_message(msg) == snapshot(
        {"type": "TurnBegin", "payload": {"user_input": "Hello, world!"}}
    )
    _test_serde(msg)

    msg = TurnBegin(user_input=[TextPart(text="Hello"), TextPart(text="world!")])
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "TurnBegin",
            "payload": {
                "user_input": [
                    {"type": "text", "text": "Hello"},
                    {"type": "text", "text": "world!"},
                ]
            },
        }
    )
    _test_serde(msg)

    msg = StepBegin(n=1)
    assert serialize_wire_message(msg) == snapshot({"type": "StepBegin", "payload": {"n": 1}})
    _test_serde(msg)

    msg = StepInterrupted()
    assert serialize_wire_message(msg) == snapshot({"type": "StepInterrupted", "payload": {}})
    _test_serde(msg)

    msg = CompactionBegin()
    assert serialize_wire_message(msg) == snapshot({"type": "CompactionBegin", "payload": {}})
    _test_serde(msg)

    msg = CompactionEnd()
    assert serialize_wire_message(msg) == snapshot({"type": "CompactionEnd", "payload": {}})
    _test_serde(msg)

    msg = StatusUpdate(context_usage=0.5)
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "StatusUpdate",
            "payload": {"context_usage": 0.5, "token_usage": None, "message_id": None},
        }
    )
    _test_serde(msg)

    msg = TextPart(text="Hello world")
    assert serialize_wire_message(msg) == snapshot(
        {"type": "ContentPart", "payload": {"type": "text", "text": "Hello world"}}
    )
    _test_serde(msg)

    msg = ImageURLPart(image_url=ImageURLPart.ImageURL(url="http://example.com/image.png"))
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "ContentPart",
            "payload": {
                "type": "image_url",
                "image_url": {"url": "http://example.com/image.png", "id": None},
            },
        }
    )
    _test_serde(msg)

    msg = ToolCall(
        id="call_123",
        function=ToolCall.FunctionBody(name="bash", arguments='{"command": "ls -la"}'),
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "ToolCall",
            "payload": {
                "type": "function",
                "id": "call_123",
                "function": {"name": "bash", "arguments": '{"command": "ls -la"}'},
                "extras": None,
            },
        }
    )
    _test_serde(msg)

    msg = ToolCallPart(arguments_part="}")
    assert serialize_wire_message(msg) == snapshot(
        {"type": "ToolCallPart", "payload": {"arguments_part": "}"}}
    )
    _test_serde(msg)

    msg = ToolResult(
        tool_call_id="call_123",
        return_value=ToolReturnValue(
            is_error=False,
            output="",
            message="Command completed",
            display=[BriefDisplayBlock(text="Command completed")],
        ),
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "ToolResult",
            "payload": {
                "tool_call_id": "call_123",
                "return_value": {
                    "is_error": False,
                    "output": "",
                    "message": "Command completed",
                    "display": [{"type": "brief", "text": "Command completed"}],
                    "extras": None,
                },
            },
        }
    )
    _test_serde(msg)

    msg = ApprovalResponse(
        request_id="request_123",
        response="approve",
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "ApprovalResponse",
            "payload": {"request_id": "request_123", "response": "approve"},
        }
    )
    _test_serde(msg)

    msg = SubagentEvent(
        task_tool_call_id="task_789",
        event=StepBegin(n=2),
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "SubagentEvent",
            "payload": {
                "task_tool_call_id": "task_789",
                "event": {"type": "StepBegin", "payload": {"n": 2}},
            },
        }
    )
    _test_serde(msg)

    with pytest.raises(ValueError):
        ApprovalResponse(request_id="request_123", response="invalid_response")  # type: ignore

    msg = ApprovalRequest(
        id="request_123",
        tool_call_id="call_999",
        sender="bash",
        action="Execute dangerous command",
        description="This command will delete files",
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "ApprovalRequest",
            "payload": {
                "id": "request_123",
                "tool_call_id": "call_999",
                "sender": "bash",
                "action": "Execute dangerous command",
                "description": "This command will delete files",
                "display": [],
            },
        }
    )
    _test_serde(msg)

    msg = ToolCallRequest(
        id="call_123",
        name="bash",
        arguments='{"command": "ls -la"}',
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "ToolCallRequest",
            "payload": {
                "id": "call_123",
                "name": "bash",
                "arguments": '{"command": "ls -la"}',
            },
        }
    )
    _test_serde(msg)


async def test_approval_request_deserialize_without_display():
    msg = deserialize_wire_message(
        {
            "type": "ApprovalRequest",
            "payload": {
                "id": "request_123",
                "tool_call_id": "call_999",
                "sender": "bash",
                "action": "Execute dangerous command",
                "description": "This command will delete files",
            },
        }
    )

    assert isinstance(msg, ApprovalRequest)
    assert msg.display == []


def test_wire_message_record_roundtrip():
    envelope = WireMessageEnvelope.from_wire_message(TurnBegin(user_input=[TextPart(text="hi")]))
    record = WireMessageRecord(timestamp=123.456, message=envelope)

    assert record.model_dump(mode="json") == snapshot(
        {
            "timestamp": 123.456,
            "message": {
                "type": "TurnBegin",
                "payload": {"user_input": [{"type": "text", "text": "hi"}]},
            },
        }
    )

    parsed = WireMessageRecord.model_validate_json(record.model_dump_json())
    assert parsed.message == envelope
    assert parsed.to_wire_message() == TurnBegin(user_input=[TextPart(text="hi")])


def test_bad_wire_message_serde():
    with pytest.raises(ValueError):
        deserialize_wire_message(None)

    with pytest.raises(ValueError):
        deserialize_wire_message([])

    with pytest.raises(ValueError):
        deserialize_wire_message({})

    with pytest.raises(ValueError):
        deserialize_wire_message(
            {
                "timestamp": 123,
                "message": {
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "Hello world"},
                },
            }
        )


def test_approval_request_resolved_compat():
    msg = deserialize_wire_message(
        {
            "type": "ApprovalRequestResolved",
            "payload": {"request_id": "request_123", "response": "approve"},
        }
    )

    assert msg == ApprovalResponse(request_id="request_123", response="approve")


async def test_type_inspection():
    msg = StepBegin(n=1)
    assert is_wire_message(msg)
    assert is_event(msg)
    assert not is_request(msg)

    msg = TextPart(text="Hello world")
    assert is_wire_message(msg)
    assert is_event(msg)
    assert not is_request(msg)

    msg = ApprovalResponse(
        request_id="request_123",
        response="approve",
    )
    assert is_wire_message(msg)
    assert is_event(msg)
    assert not is_request(msg)

    msg = ApprovalRequest(
        id="request_123",
        tool_call_id="call_999",
        sender="bash",
        action="Execute dangerous command",
        description="This command will delete files",
    )
    assert is_wire_message(msg)
    assert not is_event(msg)
    assert is_request(msg)

    msg = ToolCallRequest(
        id="call_123",
        name="bash",
        arguments="{}",
    )
    assert is_wire_message(msg)
    assert not is_event(msg)
    assert is_request(msg)


def test_wire_message_type_alias():
    import kimi_cli.wire.types

    module = kimi_cli.wire.types
    wire_message_types = {
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == module.__name__
        and issubclass(obj, BaseModel)
        and obj is not WireMessageEnvelope
    }

    for type_ in wire_message_types:
        assert type_ in module._WIRE_MESSAGE_TYPES
