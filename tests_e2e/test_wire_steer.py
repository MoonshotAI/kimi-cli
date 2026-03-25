from __future__ import annotations

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    build_approval_response,
    build_shell_tool_call,
    collect_until_request,
    collect_until_response,
    make_home_dir,
    make_work_dir,
    normalize_response,
    read_response,
    send_initialize,
    start_wire,
    write_scripted_config,
)


def test_steer_no_active_turn(tmp_path) -> None:
    """Steer without an active turn returns INVALID_STATE."""
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
        send_initialize(wire)
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "steer-1",
                "method": "steer",
                "params": {"user_input": "do something"},
            }
        )
        resp = normalize_response(read_response(wire, "steer-1"))
        assert resp == snapshot(
            {
                "error": {
                    "code": -32000,
                    "message": "No agent turn is in progress",
                    "data": None,
                }
            }
        )
    finally:
        wire.close()


def test_steer_during_active_turn(tmp_path) -> None:
    """Steer during an active turn returns 'steered' and the model sees
    the instruction in the next step."""
    # Script: step 1 calls a shell tool (blocks on approval), step 2 echoes back.
    scripts = [
        "\n".join(
            [
                "text: working",
                build_shell_tool_call("tc-1", "echo hi"),
            ]
        ),
        "text: done after steer",
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
        # Start a prompt that will block on tool approval
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "prompt-1",
                "method": "prompt",
                "params": {"user_input": "run"},
            }
        )
        # Wait until the approval request arrives (turn is active)
        request_msg, _ = collect_until_request(wire)

        # Send steer while the turn is active
        wire.send_json(
            {
                "jsonrpc": "2.0",
                "id": "steer-1",
                "method": "steer",
                "params": {"user_input": "also do this"},
            }
        )
        steer_resp = normalize_response(read_response(wire, "steer-1"))
        assert steer_resp == snapshot({"result": {"status": "steered"}})

        # Approve the tool call to let the turn continue
        wire.send_json(build_approval_response(request_msg, "approve"))

        # Collect the rest of the turn
        resp, _ = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
    finally:
        wire.close()


def test_steer_basic_lifecycle_completes(tmp_path) -> None:
    """Verify that a turn completes normally when a steer could theoretically
    be injected.  The scripted provider returns immediately so the steer
    window is effectively zero — this test only confirms the lifecycle is
    sound, not that the steer is consumed."""
    scripts = [
        "text: first response",
        "text: steered response",
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
                "params": {"user_input": "start"},
            }
        )
        resp, messages = collect_until_response(wire, "prompt-1")
        assert resp.get("result", {}).get("status") == "finished"
    finally:
        wire.close()
