from __future__ import annotations

import json
from typing import Any

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    collect_until_response,
    make_home_dir,
    make_work_dir,
    normalize_response,
    send_initialize,
    start_wire,
    summarize_messages,
    write_scripted_config,
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def test_initialize_handshake(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: hello"])
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
        resp = send_initialize(wire)
        result = _as_dict(resp.get("result"))
        assert result.get("protocol_version") == "1.1"
        assert "slash_commands" in result
        assert normalize_response(resp) == snapshot(
            {
                "result": {
                    "protocol_version": "1.1",
                    "server": {"name": "Kimi Code CLI", "version": "<VERSION>"},
                    "slash_commands": [
                        {
                            "name": "init",
                            "description": "Analyze the codebase and generate an `AGENTS.md` file",
                            "aliases": [],
                        },
                        {"name": "compact", "description": "Compact the context", "aliases": []},
                        {"name": "clear", "description": "Clear the context", "aliases": ["reset"]},
                        {
                            "name": "yolo",
                            "description": "Toggle YOLO mode (auto-approve all actions)",
                            "aliases": [],
                        },
                        {
                            "name": "skill:kimi-cli-help",
                            "description": "Answer Kimi Code CLI usage, configuration, and troubleshooting questions. Use when user asks about Kimi Code CLI installation, setup, configuration, slash commands, keyboard shortcuts, MCP integration, providers, environment variables, how something works internally, or any questions about Kimi Code CLI itself.",
                            "aliases": [],
                        },
                        {
                            "name": "skill:skill-creator",
                            "description": "Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Kimi's capabilities with specialized knowledge, workflows, or tool integrations.",
                            "aliases": [],
                        },
                    ],
                }
            }
        )
    finally:
        wire.close()


def test_initialize_external_tool_conflict(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: hello"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    external_tools = [
        {
            "name": "Shell",
            "description": "Conflicts with built-in",
            "parameters": {"type": "object", "properties": {}},
        }
    ]

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        resp = send_initialize(wire, external_tools=external_tools)
        result = _as_dict(resp.get("result"))
        external_tools_result = _as_dict(result.get("external_tools"))
        rejected = external_tools_result.get("rejected")
        assert isinstance(rejected, list)
        assert any(isinstance(item, dict) and item.get("name") == "Shell" for item in rejected)
        assert normalize_response(resp) == snapshot(
            {
                "result": {
                    "protocol_version": "1.1",
                    "server": {"name": "Kimi Code CLI", "version": "<VERSION>"},
                    "slash_commands": [
                        {
                            "name": "init",
                            "description": "Analyze the codebase and generate an `AGENTS.md` file",
                            "aliases": [],
                        },
                        {"name": "compact", "description": "Compact the context", "aliases": []},
                        {"name": "clear", "description": "Clear the context", "aliases": ["reset"]},
                        {
                            "name": "yolo",
                            "description": "Toggle YOLO mode (auto-approve all actions)",
                            "aliases": [],
                        },
                        {
                            "name": "skill:kimi-cli-help",
                            "description": "Answer Kimi Code CLI usage, configuration, and troubleshooting questions. Use when user asks about Kimi Code CLI installation, setup, configuration, slash commands, keyboard shortcuts, MCP integration, providers, environment variables, how something works internally, or any questions about Kimi Code CLI itself.",
                            "aliases": [],
                        },
                        {
                            "name": "skill:skill-creator",
                            "description": "Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Kimi's capabilities with specialized knowledge, workflows, or tool integrations.",
                            "aliases": [],
                        },
                    ],
                    "external_tools": {
                        "accepted": [],
                        "rejected": [{"name": "Shell", "reason": "conflicts with builtin tool"}],
                    },
                }
            }
        )
    finally:
        wire.close()


def test_external_tool_call(tmp_path) -> None:
    tool_args = json.dumps({"path": "README.md"})
    tool_call = json.dumps({"id": "tc-1", "name": "ext_tool", "arguments": tool_args})
    scripts = [
        "\n".join(
            [
                "text: calling external tool",
                f"tool_call: {tool_call}",
            ]
        ),
        "text: done",
    ]
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    external_tools = [
        {
            "name": "ext_tool",
            "description": "External tool",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        }
    ]

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        yolo=True,
    )
    try:
        send_initialize(wire, external_tools=external_tools)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "run external tool"},
            }
        )

        def handle_request(msg: dict[str, Any]) -> dict[str, Any]:
            params = msg.get("params")
            payload = params.get("payload") if isinstance(params, dict) else None
            tool_call_id = payload.get("id") if isinstance(payload, dict) else None
            assert isinstance(tool_call_id, str)
            return {
                "jsonrpc": "2.0",
                "id": msg.get("id"),
                "result": {
                    "tool_call_id": tool_call_id,
                    "return_value": {
                        "is_error": False,
                        "output": "Opened",
                        "message": "Opened README.md",
                        "display": [],
                    },
                },
            }

        resp, messages = collect_until_response(wire, "prompt-1", request_handler=handle_request)
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "run external tool"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "calling external tool"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {"name": "ext_tool", "arguments": '{"path": "README.md"}'},
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
                    "type": "ToolCallRequest",
                    "payload": {
                        "id": "tc-1",
                        "name": "ext_tool",
                        "arguments": '{"path": "README.md"}',
                    },
                },
                {
                    "method": "event",
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "tc-1",
                        "return_value": {
                            "is_error": False,
                            "output": "Opened",
                            "message": "Opened README.md",
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


def test_prompt_without_initialize(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: hello without init"])
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
                {"method": "event", "type": "TurnBegin", "payload": {"user_input": "hi"}},
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "hello without init"},
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
