from __future__ import annotations

import json

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    collect_until_response,
    make_home_dir,
    make_work_dir,
    send_initialize,
    start_wire,
    summarize_messages,
    write_scripts_file,
)


def test_config_string(tmp_path) -> None:
    scripts_path = write_scripts_file(tmp_path, ["text: ok"])
    config_data = {
        "default_model": "scripted",
        "models": {
            "scripted": {
                "provider": "scripted_provider",
                "model": "scripted_echo",
                "max_context_size": 100000,
            }
        },
        "providers": {
            "scripted_provider": {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_path)},
            }
        },
    }
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=None,
        config_text=json.dumps(config_data),
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
                    "payload": {"type": "text", "text": "ok"},
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


def test_model_override(tmp_path) -> None:
    scripts_a = write_scripts_file(tmp_path, ["text: from A"], name="scripts-a.json")
    scripts_b = write_scripts_file(tmp_path, ["text: from B"], name="scripts-b.json")
    config_data = {
        "default_model": "model-a",
        "models": {
            "model-a": {
                "provider": "provider-a",
                "model": "scripted_echo",
                "max_context_size": 100000,
            },
            "model-b": {
                "provider": "provider-b",
                "model": "scripted_echo",
                "max_context_size": 100000,
            },
        },
        "providers": {
            "provider-a": {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_a)},
            },
            "provider-b": {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_b)},
            },
        },
    }
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config_data), encoding="utf-8")
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)

    wire = start_wire(
        config_path=config_path,
        config_text=None,
        work_dir=work_dir,
        home_dir=home_dir,
        extra_args=["--model", "model-b"],
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
                    "payload": {"type": "text", "text": "from B"},
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
