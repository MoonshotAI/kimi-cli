from __future__ import annotations

from typing import Any

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    build_approval_response,
    build_set_todo_call,
    build_shell_tool_call,
    collect_until_request,
    collect_until_response,
    make_home_dir,
    make_work_dir,
    normalize_response,
    read_response,
    send_initialize,
    start_wire,
    summarize_messages,
    write_scripted_config,
)


def _find_event(messages: list[dict[str, Any]], event_type: str) -> dict[str, Any]:
    for msg in messages:
        if msg.get("method") != "event":
            continue
        params = msg.get("params")
        if isinstance(params, dict) and params.get("type") == event_type:
            return params
    raise AssertionError(f"Missing event {event_type}")


def test_basic_prompt_events(tmp_path) -> None:
    script = "\n".join(
        [
            "id: scripted-1",
            'usage: {"input_other": 5, "output": 2}',
            "text: Hello wire",
        ]
    )
    config_path = write_scripted_config(tmp_path, [script])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "hi"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "hi"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "Hello wire"},
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {
                        "context_usage": 5e-05,
                        "token_usage": {
                            "input_other": 5,
                            "output": 2,
                            "input_cache_read": 0,
                            "input_cache_creation": 0,
                        },
                        "message_id": "scripted-1",
                    },
                },
            ]
        )
    finally:
        wire.close()


def test_multiline_prompt(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: ok"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        user_input = "line1\nline2"
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": user_input},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        turn_begin = _find_event(messages, "TurnBegin")
        payload = turn_begin.get("payload")
        assert isinstance(payload, dict)
        assert payload.get("user_input") == user_input
        assert turn_begin == snapshot(
            {
                "type": "TurnBegin",
                "payload": {
                    "user_input": """\
line1
line2\
"""
                },
            }
        )
    finally:
        wire.close()


def test_content_part_prompt(tmp_path) -> None:
    config_path = write_scripted_config(
        tmp_path,
        ["text: ok"],
        capabilities=["image_in", "video_in"],
    )
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    content_parts = [
        {"type": "text", "text": "hello"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
        {"type": "audio_url", "audio_url": {"url": "data:audio/aac;base64,AAA"}},
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,AAA"}},
    ]
    expected_parts = [
        {"type": "text", "text": "hello"},
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,AAA", "id": None},
        },
        {
            "type": "audio_url",
            "audio_url": {"url": "data:audio/aac;base64,AAA", "id": None},
        },
        {
            "type": "video_url",
            "video_url": {"url": "data:video/mp4;base64,AAA", "id": None},
        },
    ]

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": content_parts},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        turn_begin = _find_event(messages, "TurnBegin")
        payload = turn_begin.get("payload")
        assert isinstance(payload, dict)
        assert payload.get("user_input") == expected_parts
        assert turn_begin == snapshot(
            {
                "type": "TurnBegin",
                "payload": {
                    "user_input": [
                        {"type": "text", "text": "hello"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/png;base64,AAA", "id": None},
                        },
                        {
                            "type": "audio_url",
                            "audio_url": {"url": "data:audio/aac;base64,AAA", "id": None},
                        },
                        {
                            "type": "video_url",
                            "video_url": {"url": "data:video/mp4;base64,AAA", "id": None},
                        },
                    ]
                },
            }
        )
    finally:
        wire.close()


def test_max_steps_reached(tmp_path) -> None:
    todo_line = build_set_todo_call("tc-1", [{"title": "x", "status": "pending"}])
    script = "\n".join(
        [
            "text: start",
            todo_line,
        ]
    )
    config_path = write_scripted_config(tmp_path, [script])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        extra_args=["--max-steps-per-turn", "1"],
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "run"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "max_steps_reached"
        assert normalize_response(resp) == snapshot(
            {"result": {"status": "max_steps_reached", "steps": 1}}
        )
        assert summarize_messages(messages) == snapshot(
            [
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "run"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "start"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {
                            "name": "SetTodoList",
                            "arguments": '{"todos": [{"title": "x", "status": "pending"}]}',
                        },
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {
                        "context_usage": None,
                        "token_usage": None,
                        "message_id": None,
                    },
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": False,
                            "output": "",
                            "message": "Todo list updated",
                            "display": [
                                {
                                    "type": "todo",
                                    "items": [{"title": "x", "status": "pending"}],
                                }
                            ],
                            "extras": None,
                        },
                    },
                },
            ]
        )
    finally:
        wire.close()


def test_status_update_fields(tmp_path) -> None:
    script = "\n".join(
        [
            "id: scripted-1",
            'usage: {"input_other": 5, "output": 2}',
            "text: hello",
        ]
    )
    config_path = write_scripted_config(tmp_path, [script])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "hi"},
            }
        )
        _, messages = collect_until_response(wire, "prompt-1")
        status = _find_event(messages, "StatusUpdate")
        payload = status.get("payload")
        assert isinstance(payload, dict)
        assert isinstance(payload.get("token_usage"), dict)
        assert status == snapshot(
            {
                "type": "StatusUpdate",
                "payload": {
                    "context_usage": 5e-05,
                    "token_usage": {
                        "input_other": 5,
                        "output": 2,
                        "input_cache_read": 0,
                        "input_cache_creation": 0,
                    },
                    "message_id": "scripted-1",
                },
            }
        )
    finally:
        wire.close()


def test_concurrent_prompt_error(tmp_path) -> None:
    scripts = [
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-1", "echo hi"),
            ]
        ),
        "text: done",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=False,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "run"},
            }
        )
        request_msg, messages = collect_until_request(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-2",
                "method": "prompt",
                "params": {"user_input": "second"},
            }
        )
        prompt2_resp = normalize_response(read_response(wire, "prompt-2"))
        assert prompt2_resp == snapshot(
            {
                "error": {
                    "code": -32000,
                    "message": "An agent turn is already in progress",
                    "data": None,
                }
            }
        )

        wire.send_json(build_approval_response(request_msg, "approve"))
        prompt1_resp, messages_after = collect_until_response(wire, "prompt-1")
        assert prompt1_resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages + messages_after) == snapshot(
            [
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "run"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "step1"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {
                            "name": "Shell",
                            "arguments": '{"command": "echo hi"}',
                        },
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {
                        "context_usage": None,
                        "token_usage": None,
                        "message_id": None,
                    },
                },
                {
                    "method": "request",
                    "type": "ApprovalRequest",
                    "payload": {
                        "id": "<uuid>",
                        "tool_call_id": "tc-1",
                        "sender": "Shell",
                        "action": "run command",
                        "description": "Run command `echo hi`",
                        "display": [{"type": "shell", "language": "bash", "command": "echo hi"}],
                    },
                },
                {
                    "method": "event",
                    "type": "ApprovalResponse",
                    "payload": {"request_id": "<uuid>", "response": "approve"},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": False,
                            "output": "hi\n",
                            "message": "Command executed successfully.",
                            "display": [],
                            "extras": None,
                        },
                    },
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 2}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "done"},
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {
                        "context_usage": None,
                        "token_usage": None,
                        "message_id": None,
                    },
                },
            ]
        )
    finally:
        wire.close()
