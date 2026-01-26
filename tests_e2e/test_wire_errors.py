from __future__ import annotations

import json

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    collect_until_response,
    make_home_dir,
    make_work_dir,
    normalize_response,
    send_initialize,
    start_wire,
    write_scripted_config,
    write_scripts_file,
)


def test_invalid_json_request(tmp_path) -> None:
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
        wire.send_raw("{not-json}")
        resp = wire.read_json()
        assert normalize_response(resp) == snapshot(
            {"error": {"code": -32700, "message": "Invalid JSON format", "data": None}}
        )
    finally:
        wire.close()


def test_invalid_request(tmp_path) -> None:
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
        wire.send_json({"jsonrpc": "2.1", "id": "bad"})
        resp = wire.read_json()
        assert normalize_response(resp) == snapshot(
            {"error": {"code": -32600, "message": "Invalid request", "data": None}}
        )
    finally:
        wire.close()


def test_unknown_method(tmp_path) -> None:
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
        wire.send_json({"jsonrpc": "2.0", "id": "bad", "method": "nope"})
        resp = wire.read_json()
        assert normalize_response(resp) == snapshot(
            {"error": {"code": -32601, "message": "Unexpected method received: nope", "data": None}}
        )
    finally:
        wire.close()


def test_invalid_params(tmp_path) -> None:
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
        wire.send_json({"jsonrpc": "2.0", "id": "bad", "method": "prompt", "params": {}})
        resp = wire.read_json()
        assert normalize_response(resp) == snapshot(
            {
                "error": {
                    "code": -32602,
                    "message": "Invalid parameters for method `prompt`",
                    "data": None,
                }
            }
        )
    finally:
        wire.close()


def test_cancel_without_prompt(tmp_path) -> None:
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
        wire.send_json({"jsonrpc": "2.0", "id": "cancel", "method": "cancel"})
        resp = wire.read_json()
        assert normalize_response(resp) == snapshot(
            {"error": {"code": -32000, "message": "No agent turn is in progress", "data": None}}
        )
    finally:
        wire.close()


def test_llm_not_supported(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["text: ok"], capabilities=[])
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
                "params": {
                    "user_input": [
                        {"type": "text", "text": "hello"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
                    ]
                },
            }
        )
        resp, _ = collect_until_response(wire, "prompt-1")
        assert normalize_response(resp) == snapshot(
            {
                "error": {
                    "code": -32002,
                    "message": "LLM model 'scripted_echo' does not support required capability: image_in.",
                    "data": None,
                }
            }
        )
    finally:
        wire.close()


def test_llm_not_set(tmp_path) -> None:
    scripts_path = write_scripts_file(tmp_path, ["text: ok"])
    config_data = {
        "default_model": "bad-model",
        "models": {
            "bad-model": {
                "provider": "bad-provider",
                "model": "",
                "max_context_size": 100000,
            }
        },
        "providers": {
            "bad-provider": {
                "type": "kimi",
                "base_url": "",
                "api_key": "",
                "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_path)},
            }
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
        resp, _ = collect_until_response(wire, "prompt-1")
        assert normalize_response(resp) == snapshot(
            {"error": {"code": -32001, "message": "LLM is not set", "data": None}}
        )
    finally:
        wire.close()


def test_llm_provider_error(tmp_path) -> None:
    config_path = write_scripted_config(tmp_path, ["bad line without colon"])
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
        resp, _ = collect_until_response(wire, "prompt-1")
        assert normalize_response(resp) == snapshot(
            {
                "error": {
                    "code": -32003,
                    "message": "Invalid echo DSL at line 1: 'bad line without colon'",
                    "data": None,
                }
            }
        )
    finally:
        wire.close()
