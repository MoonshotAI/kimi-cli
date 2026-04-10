"""Wire protocol tests for auth-related error handling.

Uses the new ``error:`` echo DSL directive to simulate provider-level
HTTP errors (401, 429, connection, timeout) and verifies they surface
correctly through the wire protocol.
"""

from __future__ import annotations

from tests_e2e.wire_helpers import (
    collect_until_response,
    make_home_dir,
    make_work_dir,
    normalize_response,
    send_initialize,
    start_wire,
    write_scripted_config,
)


def test_provider_401_without_oauth_surfaces_error(tmp_path) -> None:
    """A 401 from a non-OAuth provider should surface as a wire error."""
    config_path = write_scripted_config(tmp_path, ["error: 401 Token expired"])
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
                "params": {"user_input": "hello"},
            }
        )
        resp, _msgs = collect_until_response(wire, "prompt-1")
        result = normalize_response(resp)
        # Should be a provider error (code -32003)
        assert "error" in result
        error = result["error"]
        assert error["code"] == -32003
    finally:
        wire.close()


def test_provider_connection_error_surfaces(tmp_path) -> None:
    """A simulated connection error should surface as a wire error."""
    config_path = write_scripted_config(tmp_path, ["error: connection Server unreachable"])
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
                "params": {"user_input": "hello"},
            }
        )
        resp, _msgs = collect_until_response(wire, "prompt-1")
        result = normalize_response(resp)
        assert "error" in result
        error = result["error"]
        assert error["code"] == -32003
    finally:
        wire.close()


def test_provider_500_surfaces_error(tmp_path) -> None:
    """A 500 from the provider should surface as a wire error."""
    config_path = write_scripted_config(tmp_path, ["error: 500 Internal server error"])
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
                "params": {"user_input": "hello"},
            }
        )
        resp, _msgs = collect_until_response(wire, "prompt-1")
        result = normalize_response(resp)
        assert "error" in result
        error = result["error"]
        assert error["code"] == -32003
    finally:
        wire.close()
