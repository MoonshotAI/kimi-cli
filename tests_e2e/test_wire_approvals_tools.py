from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from inline_snapshot import snapshot

from .wire_helpers import (
    build_approval_response,
    build_set_todo_call,
    build_shell_tool_call,
    collect_until_response,
    make_home_dir,
    make_work_dir,
    normalize_value,
    send_initialize,
    start_wire,
    summarize_messages,
    write_scripted_config,
)


def _extract_request_payload(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for msg in messages:
        if msg.get("method") != "request":
            continue
        params = msg.get("params")
        if not isinstance(params, dict):
            continue
        payload = params.get("payload")
        if isinstance(payload, dict):
            return payload
    raise AssertionError("Missing request payload")


def _tool_call_line(tool_call_id: str, name: str, args: Mapping[str, Any]) -> str:
    payload = {"id": tool_call_id, "name": name, "arguments": json.dumps(args)}
    return f"tool_call: {json.dumps(payload)}"


def _display_types(payload: dict[str, Any]) -> list[str]:
    display = payload.get("display")
    if not isinstance(display, list):
        return []
    types: list[str] = []
    for item in display:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if isinstance(item_type, str):
            types.append(item_type)
    return types


def test_shell_approval_approve(tmp_path) -> None:
    scripts = [
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-1", "echo ok"),
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
                "params": {"user_input": "run shell"},
            }
        )
        resp, messages = collect_until_response(
            wire,
            "prompt-1",
            request_handler=lambda msg: build_approval_response(msg, "approve"),
        )
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "run shell"}},
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
                        "function": {"name": "Shell", "arguments": '{"command": "echo ok"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "request",
                    "type": "ApprovalRequest",
                    "payload": {
                        "id": "<uuid>",
                        "tool_call_id": "tc-1",
                        "sender": "Shell",
                        "action": "run command",
                        "description": "Run command `echo ok`",
                        "display": [{"type": "shell", "language": "bash", "command": "echo ok"}],
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
                            "output": "ok\n",
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()


def test_shell_approval_reject(tmp_path) -> None:
    scripts = [
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-1", "echo ok"),
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
                "params": {"user_input": "run shell"},
            }
        )
        resp, messages = collect_until_response(
            wire,
            "prompt-1",
            request_handler=lambda msg: build_approval_response(msg, "reject"),
        )
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "run shell"}},
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
                        "function": {"name": "Shell", "arguments": '{"command": "echo ok"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "request",
                    "type": "ApprovalRequest",
                    "payload": {
                        "id": "<uuid>",
                        "tool_call_id": "tc-1",
                        "sender": "Shell",
                        "action": "run command",
                        "description": "Run command `echo ok`",
                        "display": [{"type": "shell", "language": "bash", "command": "echo ok"}],
                    },
                },
                {
                    "method": "event",
                    "type": "ApprovalResponse",
                    "payload": {"request_id": "<uuid>", "response": "reject"},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": True,
                            "output": "",
                            "message": "The tool call is rejected by the user. Please follow the new instructions from the user.",
                            "display": [{"type": "brief", "text": "Rejected by user"}],
                            "extras": None,
                        },
                    },
                },
            ]
        )
    finally:
        wire.close()


def test_approve_for_session(tmp_path) -> None:
    scripts = [
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-1", "echo first"),
            ]
        ),
        "text: done",
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-2", "echo second"),
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
                "params": {"user_input": "run shell"},
            }
        )
        resp1, messages1 = collect_until_response(
            wire,
            "prompt-1",
            request_handler=lambda msg: build_approval_response(msg, "approve_for_session"),
        )
        assert resp1.get("result", {}).get("status") == "finished"

        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-2",
                "method": "prompt",
                "params": {"user_input": "run shell again"},
            }
        )
        resp2, messages2 = collect_until_response(wire, "prompt-2")
        assert resp2.get("result", {}).get("status") == "finished"
        assert all(msg.get("method") != "request" for msg in messages2)
        assert summarize_messages(messages1 + messages2) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "run shell"}},
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
                        "function": {"name": "Shell", "arguments": '{"command": "echo first"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "request",
                    "type": "ApprovalRequest",
                    "payload": {
                        "id": "<uuid>",
                        "tool_call_id": "tc-1",
                        "sender": "Shell",
                        "action": "run command",
                        "description": "Run command `echo first`",
                        "display": [{"type": "shell", "language": "bash", "command": "echo first"}],
                    },
                },
                {
                    "method": "event",
                    "type": "ApprovalResponse",
                    "payload": {"request_id": "<uuid>", "response": "approve_for_session"},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": False,
                            "output": "first\n",
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "run shell again"},
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
                        "id": "tc-2",
                        "function": {"name": "Shell", "arguments": '{"command": "echo second"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-2",
                        "return_value": {
                            "is_error": False,
                            "output": "second\n",
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()


def test_yolo_skips_approval(tmp_path) -> None:
    scripts = [
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-1", "echo ok"),
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
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "run shell"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert all(msg.get("method") != "request" for msg in messages)
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "run shell"}},
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
                        "function": {"name": "Shell", "arguments": '{"command": "echo ok"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": False,
                            "output": "ok\n",
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()


def test_display_block_shell(tmp_path) -> None:
    scripts = [
        "\n".join(
            [
                "text: step1",
                build_shell_tool_call("tc-1", "echo ok"),
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
                "params": {"user_input": "run shell"},
            }
        )
        resp, messages = collect_until_response(
            wire,
            "prompt-1",
            request_handler=lambda msg: build_approval_response(msg, "approve"),
        )
        assert resp.get("result", {}).get("status") == "finished"
        payload = _extract_request_payload(messages)
        assert "shell" in _display_types(payload)
        assert normalize_value(payload) == snapshot(
            {
                "id": "<uuid>",
                "tool_call_id": "tc-1",
                "sender": "Shell",
                "action": "run command",
                "description": "Run command `echo ok`",
                "display": [{"type": "shell", "language": "bash", "command": "echo ok"}],
            }
        )
    finally:
        wire.close()


def test_display_block_diff_write_file(tmp_path) -> None:
    write_args = {"path": "file.txt", "content": "hello", "mode": "overwrite"}
    scripts = [
        "\n".join(
            [
                "text: write",
                _tool_call_line("tc-1", "WriteFile", write_args),
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
                "params": {"user_input": "write file"},
            }
        )
        resp, messages = collect_until_response(
            wire,
            "prompt-1",
            request_handler=lambda msg: build_approval_response(msg, "approve"),
        )
        assert resp.get("result", {}).get("status") == "finished"
        payload = _extract_request_payload(messages)
        assert "diff" in _display_types(payload)
        assert normalize_value(payload) == snapshot(
            {
                "id": "<uuid>",
                "tool_call_id": "tc-1",
                "sender": "WriteFile",
                "action": "edit file",
                "description": "Write file `<work_dir>/file.txt`",
                "display": [
                    {
                        "type": "diff",
                        "path": "<work_dir>/file.txt",
                        "old_text": "",
                        "new_text": "hello",
                    }
                ],
            }
        )
    finally:
        wire.close()


def test_display_block_diff_str_replace(tmp_path) -> None:
    replace_args = {
        "path": "file.txt",
        "edit": {"old": "hello", "new": "hi", "replace_all": False},
    }
    scripts = [
        "\n".join(
            [
                "text: replace",
                _tool_call_line("tc-1", "StrReplaceFile", replace_args),
            ]
        ),
        "text: done",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    (work_dir / "file.txt").write_text("hello", encoding="utf-8")
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
                "params": {"user_input": "replace"},
            }
        )
        resp, messages = collect_until_response(
            wire,
            "prompt-1",
            request_handler=lambda msg: build_approval_response(msg, "approve"),
        )
        assert resp.get("result", {}).get("status") == "finished"
        payload = _extract_request_payload(messages)
        assert "diff" in _display_types(payload)
        assert normalize_value(payload) == snapshot(
            {
                "id": "<uuid>",
                "tool_call_id": "tc-1",
                "sender": "StrReplaceFile",
                "action": "edit file",
                "description": "Edit file `<work_dir>/file.txt`",
                "display": [
                    {
                        "type": "diff",
                        "path": "<work_dir>/file.txt",
                        "old_text": "hello",
                        "new_text": "hi",
                    }
                ],
            }
        )
    finally:
        wire.close()


def test_display_block_todo(tmp_path) -> None:
    script = "\n".join(
        ["text: todo", build_set_todo_call("tc-1", [{"title": "one", "status": "pending"}])]
    )
    scripts = [script, "text: done"]
    config_path = write_scripted_config(tmp_path, scripts)
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
                "params": {"user_input": "todo"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "todo"}},
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "todo"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {
                            "name": "SetTodoList",
                            "arguments": '{"todos": [{"title": "one", "status": "pending"}]}',
                        },
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
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
                                {"type": "todo", "items": [{"title": "one", "status": "pending"}]}
                            ],
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()


def test_tool_call_part_streaming(tmp_path) -> None:
    part_middle = '"todos":[{"title":"a","status":"pending"}]'
    part_middle_json = json.dumps({"arguments_part": part_middle})
    script = "\n".join(
        [
            "text: start",
            f"tool_call: {json.dumps({'id': 'tc-1', 'name': 'SetTodoList', 'arguments': None})}",
            'tool_call_part: {"arguments_part": "{"}',
            f"tool_call_part: {part_middle_json}",
            'tool_call_part: {"arguments_part": "}"}',
            "tool_call_part:",
        ]
    )
    config_path = write_scripted_config(tmp_path, [script, "text: done"])
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
                "params": {"user_input": "stream"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "stream"}},
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
                        "function": {"name": "SetTodoList", "arguments": None},
                        "extras": None,
                    },
                },
                {"method": "event", "type": "ToolCallPart", "payload": {"arguments_part": "{"}},
                {
                    "method": "event",
                    "type": "ToolCallPart",
                    "payload": {"arguments_part": '"todos":[{"title":"a","status":"pending"}]'},
                },
                {"method": "event", "type": "ToolCallPart", "payload": {"arguments_part": "}"}},
                {"method": "event", "type": "ToolCallPart", "payload": {"arguments_part": None}},
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
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
                                {"type": "todo", "items": [{"title": "a", "status": "pending"}]}
                            ],
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()


def test_default_agent_missing_tool(tmp_path) -> None:
    dmail_args = {"message": "hi"}
    scripts = [
        "\n".join(
            [
                "text: missing tool",
                _tool_call_line("tc-1", "SendDMail", dmail_args),
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
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "dmail"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "dmail"}},
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "missing tool"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {"name": "SendDMail", "arguments": '{"message": "hi"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": True,
                            "output": "",
                            "message": "Tool `SendDMail` not found",
                            "display": [{"type": "brief", "text": "Tool `SendDMail` not found"}],
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()


def test_custom_agent_exclude_tool(tmp_path) -> None:
    shell_args = {"command": "echo hi"}
    scripts = [
        "\n".join(
            [
                "text: missing tool",
                _tool_call_line("tc-1", "Shell", shell_args),
            ]
        ),
        "text: done",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    agent_path = tmp_path / "agent.yaml"
    agent_path.write_text(
        "\n".join(
            [
                "version: 1",
                "agent:",
                "  extend: default",
                "  exclude_tools:",
                '    - "kimi_cli.tools.shell:Shell"',
            ]
        ),
        encoding="utf-8",
    )
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
        agent_file=agent_path,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "shell"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "shell"}},
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "missing tool"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {"name": "Shell", "arguments": '{"command": "echo hi"}'},
                        "extras": None,
                    },
                },
                {
                    "method": "event",
                    "type": "StatusUpdate",
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": True,
                            "output": "",
                            "message": "Tool `Shell` not found",
                            "display": [{"type": "brief", "text": "Tool `Shell` not found"}],
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
                    "payload": {"context_usage": None, "token_usage": None, "message_id": None},
                },
            ]
        )
    finally:
        wire.close()
