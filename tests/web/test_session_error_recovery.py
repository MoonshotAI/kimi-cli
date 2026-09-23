"""Tests for session error recovery in process.py and sessions.py.

Verifies that _in_flight_prompt_ids is properly cleared on errors so
that sessions don't get stuck in a permanent "busy" state.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from kimi_cli.web.models import SessionStatus
from kimi_cli.web.runner.process import SessionProcess

# ---------------------------------------------------------------------------
# Tests: SessionProcess.clear_in_flight
# ---------------------------------------------------------------------------


def test_clear_in_flight_resets_is_busy() -> None:
    """clear_in_flight should empty _in_flight_prompt_ids so is_busy is False."""
    sp = SessionProcess(uuid4())
    sp._in_flight_prompt_ids.add("prompt-1")
    sp._in_flight_prompt_ids.add("prompt-2")

    assert sp.is_busy is True

    sp.clear_in_flight()

    assert sp.is_busy is False
    assert len(sp._in_flight_prompt_ids) == 0


# ---------------------------------------------------------------------------
# Tests: _read_loop clears in-flight on unexpected exception
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_loop_clears_in_flight_on_exception() -> None:
    """When _read_loop encounters a non-EOF, non-CancelledError exception,
    it should clear _in_flight_prompt_ids and emit an error status.
    """
    sp = SessionProcess(uuid4())
    sp._in_flight_prompt_ids.add("prompt-in-flight")
    assert sp.is_busy is True

    # Create a mock process whose stdout has one line then EOF
    mock_stdout = asyncio.StreamReader()
    mock_stdout.feed_data(b"not-valid-json\n")
    mock_stdout.feed_eof()

    mock_stderr = asyncio.StreamReader()
    mock_stderr.feed_data(b"mock stderr")
    mock_stderr.feed_eof()

    mock_process = MagicMock()
    mock_process.stdout = mock_stdout
    mock_process.stderr = mock_stderr
    mock_process.returncode = None

    sp._process = mock_process

    # _broadcast raises on the first call (the stdout line),
    # succeeds on subsequent calls (_emit_status broadcast).
    call_count = 0

    async def failing_then_ok_broadcast(msg: str) -> None:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("broadcast failed")

    sp._broadcast = failing_then_ok_broadcast  # type: ignore[assignment]

    await sp._read_loop()

    assert sp.is_busy is False
    assert sp.status.state == "error"
    assert sp.status.reason == "read_loop_error"


# ---------------------------------------------------------------------------
# Tests: EOF path clears in-flight before broadcast
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_loop_eof_clears_in_flight_before_broadcast() -> None:
    """On worker process EOF, _in_flight_prompt_ids should be cleared
    before _broadcast is called, so that is_busy is already False when
    the frontend reacts to the error.
    """
    sp = SessionProcess(uuid4())
    sp._in_flight_prompt_ids.add("prompt-in-flight")

    # Track is_busy at the time broadcast is called
    busy_at_broadcast: list[bool] = []

    async def tracking_broadcast(msg: str) -> None:
        busy_at_broadcast.append(sp.is_busy)

    sp._broadcast = tracking_broadcast  # type: ignore[assignment]

    # Create a mock process that immediately returns EOF
    mock_stdout = asyncio.StreamReader()
    mock_stdout.feed_eof()

    mock_stderr = asyncio.StreamReader()
    mock_stderr.feed_data(b"worker crashed")
    mock_stderr.feed_eof()

    mock_process = MagicMock()
    mock_process.stdout = mock_stdout
    mock_process.stderr = mock_stderr
    mock_process.returncode = 1

    sp._process = mock_process
    sp._expecting_exit = False

    await sp._read_loop()

    # At the time broadcast was called, is_busy should already be False
    assert busy_at_broadcast[0] is False
    assert sp.status.state == "error"


# ---------------------------------------------------------------------------
# Tests: error state allows recovery with new prompt
# ---------------------------------------------------------------------------


def test_session_in_error_state_clears_stale_ids_on_new_prompt() -> None:
    """When a session is in error state and is_busy is True (stale IDs),
    clear_in_flight should be callable to recover the session.
    This tests the building block used by the sessions.py WebSocket handler.
    """
    session_id = uuid4()
    sp = SessionProcess(session_id)

    # Simulate: session errored out but _in_flight_prompt_ids was not cleared
    sp._in_flight_prompt_ids.add("stale-prompt")
    sp._status = SessionStatus(
        session_id=session_id,
        state="error",
        seq=1,
        worker_id=None,
        reason="process_exit",
        detail=None,
        updated_at=datetime.now(UTC),
    )

    assert sp.is_busy is True
    assert sp.status.state == "error"

    # The sessions.py handler checks this condition and calls clear_in_flight
    if sp.status.state == "error" and sp.is_busy:
        sp.clear_in_flight()

    assert sp.is_busy is False


# ---------------------------------------------------------------------------
# Tests: send_message broken stdin clears in-flight
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_message_broken_pipe_clears_in_flight() -> None:
    """A BrokenPipeError while writing a prompt to stdin must drop the prompt's
    in-flight id, so the failed turn doesn't leave the session stuck in 'busy'.
    """
    sp = SessionProcess(uuid4())

    # Don't spawn a real subprocess.
    async def noop_start() -> None:
        return None

    sp.start = noop_start  # type: ignore[assignment]

    # stdin whose drain() reports the worker is gone.
    async def broken_drain() -> None:
        raise BrokenPipeError("worker gone")

    mock_stdin = MagicMock()
    mock_stdin.drain = broken_drain

    mock_process = MagicMock()
    mock_process.stdin = mock_stdin
    mock_process.returncode = 1
    sp._process = mock_process

    # Keep the message untouched and broadcasts inert.
    async def passthrough_handle(in_message: object) -> None:
        return None

    async def noop_broadcast(msg: str) -> None:
        return None

    sp._handle_in_message = passthrough_handle  # type: ignore[assignment]
    sp._broadcast = noop_broadcast  # type: ignore[assignment]

    prompt = '{"jsonrpc":"2.0","method":"prompt","id":"p1","params":{"user_input":"hi"}}'
    await sp.send_message(prompt)

    assert "p1" not in sp._in_flight_prompt_ids
    assert sp.is_busy is False
    assert sp.status.state == "error"
    assert sp.status.reason == "stdin_broken"
