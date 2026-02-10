from __future__ import annotations

import hashlib
import json
import sys
import textwrap
from pathlib import Path

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    build_approval_response,
    collect_until_response,
    make_home_dir,
    make_work_dir,
    send_initialize,
    share_dir,
    start_wire,
    summarize_messages,
    write_scripted_config,
)


def _session_dir(home_dir: Path, work_dir: Path, session_id: str) -> Path:
    digest = hashlib.md5(str(work_dir).encode("utf-8")).hexdigest()
    return share_dir(home_dir) / "sessions" / digest / session_id


def _read_user_texts(context_file: Path) -> list[str]:
    texts: list[str] = []
    for line in context_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        if payload.get("role") != "user":
            continue
        content = payload.get("content", "")
        if isinstance(content, str):
            texts.append(content)
            continue
        if isinstance(content, list):
            text = "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
            texts.append(text)
    return texts


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def test_skill_prompt_injects_skill_text(tmp_path) -> None:
    skill_dir = tmp_path / "skills"
    skill_path = skill_dir / "test-skill"
    skill_path.mkdir(parents=True)
    skill_text = "\n".join(
        [
            "---",
            "name: test",
            "description: Test skill",
            "---",
            "",
            "Use this skill in wire tests.",
        ]
    )
    skill_path.joinpath("SKILL.md").write_text(skill_text + "\n", encoding="utf-8")

    config_path = write_scripted_config(tmp_path, ["text: skill ok"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    session_id = "skill-session"

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        skills_dir=skill_dir,
        extra_args=["--session", session_id],
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "/skill:test"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "/skill:test"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "skill ok"},
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
                {"method": "event", "type": "TurnEnd", "payload": {}},
            ]
        )
    finally:
        wire.close()

    context_file = _session_dir(home_dir, work_dir, session_id) / "context.jsonl"
    user_texts = _read_user_texts(context_file)
    assert user_texts
    assert _normalize_newlines(user_texts[-1]) == _normalize_newlines(skill_text.strip())


def test_flow_skill(tmp_path) -> None:
    skill_dir = tmp_path / "skills"
    flow_dir = skill_dir / "test-flow"
    flow_dir.mkdir(parents=True)
    flow_dir.joinpath("SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: test-flow",
                "description: Test flow",
                "type: flow",
                "---",
                "",
                "```mermaid",
                "flowchart TD",
                "A([BEGIN]) --> B[Say hello]",
                "B --> C([END])",
                "```",
            ]
        ),
        encoding="utf-8",
    )

    config_path = write_scripted_config(tmp_path, ["text: flow done"])
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        skills_dir=skill_dir,
        yolo=True,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "/flow:test-flow"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
        assert summarize_messages(messages) == snapshot(
            [
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "/flow:test-flow"},
                },
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "Say hello"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "flow done"},
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
                {"method": "event", "type": "TurnEnd", "payload": {}},
                {"method": "event", "type": "TurnEnd", "payload": {}},
            ]
        )
    finally:
        wire.close()


def test_mcp_tool_call(tmp_path) -> None:
    server_path = tmp_path / "mcp_server.py"
    server_path.write_text(
        textwrap.dedent(
            """
            from fastmcp.server import FastMCP

            server = FastMCP("test-mcp")

            @server.tool
            def ping(text: str) -> str:
                return f"pong:{text}"

            if __name__ == "__main__":
                server.run(transport="stdio", show_banner=False)
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    mcp_config = {
        "mcpServers": {
            "test": {
                "command": sys.executable,
                "args": [str(server_path)],
            }
        }
    }
    mcp_config_path = tmp_path / "mcp.json"
    mcp_config_path.write_text(json.dumps(mcp_config), encoding="utf-8")

    tool_args = json.dumps({"text": "hi"})
    tool_call = json.dumps({"id": "tc-1", "name": "ping", "arguments": tool_args})
    scripts = [
        "\n".join(
            [
                "text: call mcp",
                f"tool_call: {tool_call}",
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
        mcp_config_path=mcp_config_path,
        yolo=False,
    )
    try:
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "call mcp"},
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
                {
                    "method": "event",
                    "type": "TurnBegin",
                    "payload": {"user_input": "call mcp"},
                },
                {"method": "event", "type": "StepBegin", "payload": {"n": 1}},
                {
                    "method": "event",
                    "type": "ContentPart",
                    "payload": {"type": "text", "text": "call mcp"},
                },
                {
                    "method": "event",
                    "type": "ToolCall",
                    "payload": {
                        "type": "function",
                        "id": "tc-1",
                        "function": {"name": "ping", "arguments": '{"text": "hi"}'},
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
                        "sender": "ping",
                        "action": "mcp:ping",
                        "description": "Call MCP tool `ping`.",
                        "display": [],
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
                            "output": [{"type": "text", "text": "pong:hi"}],
                            "message": "",
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
                {"method": "event", "type": "TurnEnd", "payload": {}},
            ]
        )
    finally:
        wire.close()
