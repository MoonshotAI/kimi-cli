import pytest
from inline_snapshot import snapshot
from kosong.message import ImageURLPart, TextPart, ToolCall, ToolCallPart

from kimi_cli.soul import StatusSnapshot
from kimi_cli.wire.message import (
    ApprovalRequest,
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    SubagentEvent,
)


@pytest.mark.asyncio
async def test_wire_message_serialization():
    """Test serialization of all WireMessage types."""

    msg = StepBegin(n=1)
    assert msg.model_dump(exclude_none=True) == snapshot({"n": 1})

    msg = StepInterrupted()
    assert msg.model_dump(exclude_none=True) == snapshot({})

    msg = CompactionBegin()
    assert msg.model_dump(exclude_none=True) == snapshot({})

    msg = CompactionEnd()
    assert msg.model_dump(exclude_none=True) == snapshot({})

    status = StatusSnapshot(context_usage=0.5)
    msg = StatusUpdate(status=status)
    assert msg.model_dump(exclude_none=True) == snapshot({"status": {"context_usage": 0.5}})

    msg = TextPart(text="Hello world")
    assert msg.model_dump(exclude_none=True) == snapshot({"type": "text", "text": "Hello world"})

    msg = ImageURLPart(image_url=ImageURLPart.ImageURL(url="http://example.com/image.png"))
    assert msg.model_dump(exclude_none=True) == snapshot(
        {"type": "image_url", "image_url": {"url": "http://example.com/image.png"}}
    )

    msg = ToolCall(
        id="call_123",
        function=ToolCall.FunctionBody(name="bash", arguments='{"command": "ls -la"}'),
    )
    assert msg.model_dump(exclude_none=True) == snapshot(
        {
            "type": "function",
            "id": "call_123",
            "function": {"name": "bash", "arguments": '{"command": "ls -la"}'},
        }
    )

    msg = ToolCallPart(arguments_part="}")
    assert msg.model_dump(exclude_none=True) == snapshot({"arguments_part": "}"})

    # msg = ToolResult(
    #     tool_call_id="call_123",
    #     return_value=ToolOk(output="success", message="Command completed", brief="ls output"),
    # )
    # assert msg.model_dump(exclude_none=True) == snapshot()

    # msg = ToolResult(
    #     tool_call_id="call_456",
    #     return_value=ToolError(output="error", message="Command failed", brief="Error output"),
    # )
    # assert msg.model_dump(exclude_none=True) == snapshot()

    subagent_event = StepBegin(n=2)
    msg = SubagentEvent(task_tool_call_id="task_789", event=subagent_event)
    assert msg.model_dump(exclude_none=True) == snapshot(
        {"task_tool_call_id": "task_789", "event": {"n": 2}}
    )

    msg = ApprovalRequest(
        tool_call_id="call_999",
        sender="bash",
        action="Execute dangerous command",
        description="This command will delete files",
    )
    dumped = msg.model_dump(exclude_none=True)
    del dumped["id"]
    assert dumped == snapshot(
        {
            "tool_call_id": "call_999",
            "sender": "bash",
            "action": "Execute dangerous command",
            "description": "This command will delete files",
        }
    )
