import pytest
from inline_snapshot import snapshot
from kosong.message import ImageURLPart, TextPart, ToolCall, ToolCallPart
from kosong.tooling import DisplayBlock, ToolResult, ToolReturnValue

from kimi_cli.wire.message import (
    ApprovalRequest,
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    SubagentEvent,
    TurnBegin,
    WireMessage,
    is_event,
    is_request,
    is_wire_message,
)
from kimi_cli.wire.serde import deserialize_wire_message, serialize_wire_message


def _test_serde(msg: WireMessage):
    serialized = serialize_wire_message(msg)
    deserialized = deserialize_wire_message(serialized)
    assert deserialized == msg


@pytest.mark.asyncio
async def test_wire_message_serialization():
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
        {"type": "StatusUpdate", "payload": {"context_usage": 0.5}}
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
            display=[DisplayBlock(type="brief", data="Command completed")],
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
                    "display": [{"type": "brief", "data": "Command completed"}],
                    "extras": None,
                },
            },
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
            },
        }
    )
    _test_serde(msg)


@pytest.mark.asyncio
async def test_type_inspection():
    msg = StepBegin(n=1)
    assert is_wire_message(msg)
    assert is_event(msg)
    assert not is_request(msg)

    msg = TextPart(text="Hello world")
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
