from __future__ import annotations

import json

from kosong.tooling import ToolReturnValue

from kimi_cli.ui.print.visualize import FinalOnlyJsonPrinter, FinalOnlyTextPrinter, JsonPrinter
from kimi_cli.wire.types import (
    Notification,
    StepRetry,
    TextPart,
    ToolCall,
    ToolCallPart,
    ToolResult,
)


def _notification() -> Notification:
    return Notification(
        id="n1234567",
        category="task",
        type="task.completed",
        source_kind="background_task",
        source_id="b1234567",
        title="Background task completed: build project",
        body="Task ID: b1234567\nStatus: completed",
        severity="success",
        created_at=123.456,
        payload={"task_id": "b1234567"},
    )


def _tool_call() -> ToolCall:
    return ToolCall(
        id="call_123",
        function=ToolCall.FunctionBody(name="Shell", arguments='{"command"'),
    )


def _tool_result() -> ToolResult:
    return ToolResult(
        tool_call_id="call_123",
        return_value=ToolReturnValue(
            is_error=False,
            output="",
            message="Command completed",
            display=[],
        ),
    )


def _step_retry() -> StepRetry:
    return StepRetry(
        n=1,
        next_attempt=2,
        max_attempts=3,
        wait_s=1.0,
        error_type="APIStatusError",
        status_code=429,
    )


def test_json_printer_emits_notification_as_distinct_json_event(capsys):
    printer = JsonPrinter()

    printer.feed(_notification())

    output = capsys.readouterr().out.strip()
    payload = json.loads(output)
    assert payload["id"] == "n1234567"
    assert payload["type"] == "task.completed"
    assert payload["title"] == "Background task completed: build project"


def test_json_printer_preserves_tool_result_when_notification_interleaves(capsys):
    printer = JsonPrinter()

    printer.feed(
        ToolCall(
            id="call_123",
            function=ToolCall.FunctionBody(
                name="Shell",
                arguments='{"command":"sleep 2","timeout":5}',
            ),
        )
    )
    printer.feed(_notification())
    printer.feed(_tool_result())

    outputs = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]

    assert [item.get("role", "notification") for item in outputs] == [
        "assistant",
        "notification",
        "tool",
    ]
    assert outputs[0]["tool_calls"][0]["id"] == "call_123"
    assert outputs[1]["id"] == "n1234567"
    assert outputs[2]["tool_call_id"] == "call_123"
    assert outputs[2]["content"] == "<system>Command completed</system>"


def test_json_printer_keeps_merged_tool_call_arguments_before_notification(capsys):
    printer = JsonPrinter()

    printer.feed(_tool_call())
    printer.feed(ToolCallPart(arguments_part=': "ls"}'))
    printer.feed(_notification())
    printer.feed(_tool_result())

    outputs = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]

    assert len(outputs) == 3
    assert outputs[0]["tool_calls"][0]["function"]["arguments"] == '{"command": "ls"}'
    assert outputs[1]["type"] == "task.completed"
    assert outputs[2]["tool_call_id"] == "call_123"


def test_json_printer_buffers_notification_during_tool_call_streaming(capsys):
    """Notification arriving between ToolCall and ToolCallPart must not truncate arguments.

    Before the fix, only _content_buffer was checked.  A Notification arriving
    while _tool_call_buffer was non-empty (but _content_buffer empty) would
    prematurely flush the incomplete assistant message and clear _last_tool_call,
    causing subsequent ToolCallPart chunks to be silently dropped.
    """
    printer = JsonPrinter()

    # ToolCall with partial arguments
    printer.feed(_tool_call())  # arguments = '{"command"'
    # Notification arrives mid-streaming (no content yet, but tool call is pending)
    printer.feed(_notification())
    # Remaining arguments arrive
    printer.feed(ToolCallPart(arguments_part=': "ls"}'))
    # Tool result completes the cycle
    printer.feed(_tool_result())

    outputs = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]

    # Expected order: assistant (with complete tool call) → notification → tool result
    assert len(outputs) == 3
    assert outputs[0]["role"] == "assistant"
    assert outputs[0]["tool_calls"][0]["function"]["arguments"] == '{"command": "ls"}'
    assert outputs[1]["id"] == "n1234567"
    assert outputs[2]["tool_call_id"] == "call_123"


def test_json_printer_does_not_split_streamed_assistant_message_for_notification(capsys):
    printer = JsonPrinter()

    printer.feed(TextPart(text="hello"))
    printer.feed(_notification())
    printer.feed(TextPart(text=" world"))
    printer.flush()

    outputs = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]

    assert len(outputs) == 2
    assert outputs[0]["role"] == "assistant"
    assert outputs[0]["content"] == "hello world"
    assert outputs[1]["id"] == "n1234567"


def test_json_printer_drops_partial_assistant_on_step_retry(capsys):
    printer = JsonPrinter()

    printer.feed(TextPart(text="old"))
    printer.feed(_tool_call())
    printer.feed(_step_retry())
    printer.feed(TextPart(text="new"))
    printer.flush()

    outputs = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]

    assert len(outputs) == 1
    assert outputs[0]["role"] == "assistant"
    assert outputs[0]["content"] == "new"
    assert "tool_calls" not in outputs[0]


def test_final_only_text_printer_drops_partial_assistant_on_step_retry(capsys):
    printer = FinalOnlyTextPrinter()

    printer.feed(TextPart(text="old"))
    printer.feed(_step_retry())
    printer.feed(TextPart(text="new"))
    printer.flush()

    assert capsys.readouterr().out.strip() == "new"


def test_final_only_json_printer_drops_partial_assistant_on_step_retry(capsys):
    printer = FinalOnlyJsonPrinter()

    printer.feed(TextPart(text="old"))
    printer.feed(_step_retry())
    printer.feed(TextPart(text="new"))
    printer.flush()

    output = json.loads(capsys.readouterr().out.strip())

    assert output["role"] == "assistant"
    assert output["content"] == "new"
