import inspect
from pathlib import Path

import pytest
from inline_snapshot import snapshot
from pydantic import BaseModel

from kimi_cli.wire.file import WireMessageRecord
from kimi_cli.wire.serde import deserialize_wire_message, serialize_wire_message
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BriefDisplayBlock,
    CompactionBegin,
    CompactionEnd,
    ImageURLPart,
    MCPLoadingBegin,
    MCPLoadingEnd,
    MCPServerSnapshot,
    MCPStatusSnapshot,
    Notification,
    PlanDisplay,
    QuestionItem,
    QuestionOption,
    QuestionRequest,
    QuestionResponse,
    StatusUpdate,
    SteerInput,
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
    TurnEnd,
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

    msg = TurnEnd()
    assert serialize_wire_message(msg) == snapshot({"type": "TurnEnd", "payload": {}})
    _test_serde(msg)

    msg = SteerInput(user_input="Follow up")
    assert serialize_wire_message(msg) == snapshot(
        {"type": "SteerInput", "payload": {"user_input": "Follow up"}}
    )
    _test_serde(msg)

    msg = SteerInput(
        user_input=[
            TextPart(text="Look"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image")),
        ]
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "SteerInput",
            "payload": {
                "user_input": [
                    {"type": "text", "text": "Look"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "https://example.com/image", "id": None},
                    },
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

    msg = MCPLoadingBegin()
    assert serialize_wire_message(msg) == snapshot({"type": "MCPLoadingBegin", "payload": {}})
    _test_serde(msg)

    msg = MCPLoadingEnd()
    assert serialize_wire_message(msg) == snapshot({"type": "MCPLoadingEnd", "payload": {}})
    _test_serde(msg)

    msg = StatusUpdate(
        context_usage=0.5,
        mcp_status=MCPStatusSnapshot(
            loading=True,
            connected=0,
            total=1,
            tools=0,
            servers=(MCPServerSnapshot(name="context7", status="connecting"),),
        ),
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "StatusUpdate",
            "payload": {
                "context_usage": 0.5,
                "context_tokens": None,
                "max_context_tokens": None,
                "token_usage": None,
                "message_id": None,
                "plan_mode": None,
                "mcp_status": {
                    "loading": True,
                    "connected": 0,
                    "total": 1,
                    "tools": 0,
                    "servers": [
                        {
                            "name": "context7",
                            "status": "connecting",
                            "tools": [],
                        }
                    ],
                },
            },
        }
    )
    _test_serde(msg)

    msg = Notification(
        id="n1234567",
        category="task",
        type="task.completed",
        source_kind="background_task",
        source_id="b1234567",
        title="Background task completed",
        body="Task ID: b1234567",
        severity="success",
        created_at=123.456,
        payload={"task_id": "b1234567"},
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "Notification",
            "payload": {
                "id": "n1234567",
                "category": "task",
                "type": "task.completed",
                "source_kind": "background_task",
                "source_id": "b1234567",
                "title": "Background task completed",
                "body": "Task ID: b1234567",
                "severity": "success",
                "created_at": 123.456,
                "payload": {"task_id": "b1234567"},
            },
        }
    )
    _test_serde(msg)

    msg = PlanDisplay(
        content="## Plan\n\n1. Step one\n2. Step two",
        file_path="/Users/test/.kimi/plans/iron-man-spider-man.md",
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "PlanDisplay",
            "payload": {
                "content": "## Plan\n\n1. Step one\n2. Step two",
                "file_path": "/Users/test/.kimi/plans/iron-man-spider-man.md",
            },
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
            "payload": {"request_id": "request_123", "response": "approve", "feedback": ""},
        }
    )
    _test_serde(msg)

    msg = SubagentEvent(
        parent_tool_call_id="call_parent_789",
        agent_id="a1234567",
        subagent_type="coder",
        event=StepBegin(n=2),
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "SubagentEvent",
            "payload": {
                "parent_tool_call_id": "call_parent_789",
                "agent_id": "a1234567",
                "subagent_type": "coder",
                "event": {"type": "StepBegin", "payload": {"n": 2}},
            },
        }
    )
    _test_serde(msg)

    legacy_msg = deserialize_wire_message(
        {
            "type": "SubagentEvent",
            "payload": {
                "task_tool_call_id": "call_parent_legacy",
                "event": {"type": "StepBegin", "payload": {"n": 3}},
            },
        }
    )
    assert isinstance(legacy_msg, SubagentEvent)
    assert legacy_msg.parent_tool_call_id == "call_parent_legacy"
    assert legacy_msg.agent_id is None
    assert legacy_msg.subagent_type is None
    assert legacy_msg.event == StepBegin(n=3)

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
                "source_kind": None,
                "source_id": None,
                "agent_id": None,
                "subagent_type": None,
                "source_description": None,
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

    msg = QuestionRequest(
        id="question_001",
        tool_call_id="call_456",
        questions=[
            QuestionItem(
                question="Which library?",
                header="Library",
                options=[
                    QuestionOption(label="React", description="A JS library"),
                    QuestionOption(label="Vue", description="A progressive framework"),
                ],
                multi_select=False,
            )
        ],
    )
    assert serialize_wire_message(msg) == snapshot(
        {
            "type": "QuestionRequest",
            "payload": {
                "id": "question_001",
                "tool_call_id": "call_456",
                "questions": [
                    {
                        "question": "Which library?",
                        "header": "Library",
                        "options": [
                            {"label": "React", "description": "A JS library"},
                            {"label": "Vue", "description": "A progressive framework"},
                        ],
                        "multi_select": False,
                        "body": "",
                        "other_label": "",
                        "other_description": "",
                    }
                ],
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

    msg = Notification(
        id="n1234567",
        category="system",
        type="system.info",
        source_kind="test",
        source_id="source-1",
        title="Info",
        body="body",
        severity="info",
        created_at=1.0,
    )
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

    msg = QuestionRequest(
        id="question_001",
        tool_call_id="call_456",
        questions=[
            QuestionItem(
                question="Pick one?",
                options=[
                    QuestionOption(label="A", description=""),
                    QuestionOption(label="B", description=""),
                ],
            )
        ],
    )
    assert is_wire_message(msg)
    assert not is_event(msg)
    assert is_request(msg)


async def test_question_request_resolve():
    """Test basic resolve → wait flow for QuestionRequest."""
    request = QuestionRequest(
        id="q1",
        tool_call_id="tc1",
        questions=[
            QuestionItem(
                question="Pick?",
                options=[
                    QuestionOption(label="A", description=""),
                    QuestionOption(label="B", description=""),
                ],
            )
        ],
    )
    assert not request.resolved
    request.resolve({"Pick?": "A"})
    assert request.resolved
    result = await request.wait()
    assert result == {"Pick?": "A"}


async def test_question_request_resolve_empty():
    """Test resolve with empty answers dict."""
    request = QuestionRequest(
        id="q2",
        tool_call_id="tc2",
        questions=[
            QuestionItem(
                question="Pick?",
                options=[
                    QuestionOption(label="A", description=""),
                    QuestionOption(label="B", description=""),
                ],
            )
        ],
    )
    request.resolve({})
    result = await request.wait()
    assert result == {}
    assert request.resolved


def test_wire_message_type_alias():
    import kimi_cli.wire.types

    module = kimi_cli.wire.types
    # Helper types that are BaseModel subclasses but not WireMessage types
    from kimi_cli.wire.types import HookResponse

    _NON_WIRE_TYPES = {
        WireMessageEnvelope,
        MCPServerSnapshot,
        MCPStatusSnapshot,
        QuestionOption,
        QuestionItem,
        QuestionResponse,
        HookResponse,
    }

    wire_message_types = {
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == module.__name__
        and issubclass(obj, BaseModel)
        and obj not in _NON_WIRE_TYPES
    }

    for type_ in wire_message_types:
        assert type_ in module._WIRE_MESSAGE_TYPES


def test_read_wire_lines_request_id(tmp_path: Path):
    """Verify _read_wire_lines emits a top-level JSON-RPC ``id`` for request messages.

    wire.jsonl stores messages as ``{"type": "QuestionRequest", "payload": {"id": ..., ...}}``.
    The ``id`` lives inside ``payload``, NOT at the top of ``message``.  _read_wire_lines
    must extract it to the top-level ``id`` field of the JSON-RPC envelope so that the
    frontend client can correlate responses.

    Regression test for a bug where ``message_raw.get("id")`` was used instead of
    ``message.id``, always producing an empty string.
    """
    import json
    import time

    from kimi_cli.web.api.sessions import _read_wire_lines

    # Build a realistic wire.jsonl with request and event messages
    wire_file = tmp_path / "wire.jsonl"

    question_req = QuestionRequest(
        id="q-abc-123",
        tool_call_id="tc-1",
        questions=[
            QuestionItem(
                question="Pick one?",
                options=[
                    QuestionOption(label="A", description="Option A"),
                    QuestionOption(label="B", description="Option B"),
                ],
            )
        ],
    )
    approval_req = ApprovalRequest(
        id="a-def-456",
        action="write",
        description="Write to file.txt",
        sender="Agent",
        tool_call_id="tc-2",
    )
    step_begin = StepBegin(n=1)

    records = []
    for msg in [step_begin, question_req, approval_req]:
        envelope = WireMessageEnvelope.from_wire_message(msg)
        record = {"timestamp": time.time(), "message": envelope.model_dump(mode="json")}
        records.append(json.dumps(record, ensure_ascii=False))

    wire_file.write_text("\n".join(records) + "\n")

    # Parse
    lines = _read_wire_lines(wire_file)
    assert len(lines) == 3

    parsed = [json.loads(line) for line in lines]

    # StepBegin is an event — should have method=event and NO id
    event_msg = parsed[0]
    assert event_msg["method"] == "event"
    assert "id" not in event_msg

    # QuestionRequest — must have method=request and correct top-level id
    question_msg = parsed[1]
    assert question_msg["method"] == "request"
    assert question_msg["id"] == "q-abc-123", (
        f"Expected top-level id='q-abc-123', got '{question_msg.get('id')}'. "
        "The id must come from the deserialized request object, not message_raw dict."
    )

    # ApprovalRequest — same check
    approval_msg = parsed[2]
    assert approval_msg["method"] == "request"
    assert approval_msg["id"] == "a-def-456"
