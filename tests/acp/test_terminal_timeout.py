from __future__ import annotations

from types import SimpleNamespace

import pytest

from kimi_cli.acp.tools import Terminal
from kimi_cli.tools.shell import Params as ShellParams

pytestmark = pytest.mark.asyncio


class _FakeACPConn:
    def __init__(self, *, timeout_error: bool = False):
        self.timeout_error = timeout_error
        self.killed_terminal = False
        self.released_terminal = False

    async def create_terminal(self, **_kwargs):
        return SimpleNamespace(terminal_id="term-1")

    async def session_update(self, **_kwargs):
        return None

    async def wait_for_terminal_exit(self, **_kwargs):
        if self.timeout_error:
            raise TimeoutError
        return SimpleNamespace(exit_code=0, signal=None)

    async def kill_terminal(self, **_kwargs):
        self.killed_terminal = True
        return None

    async def terminal_output(self, **_kwargs):
        return SimpleNamespace(
            output="",
            truncated=False,
            exit_status=None,
        )

    async def release_terminal(self, **_kwargs):
        self.released_terminal = True
        return None


async def test_terminal_uses_effective_timeout_from_alias(shell_tool, approval, monkeypatch):
    captured: dict[str, float] = {}

    class _FakeTimeoutCtx:
        def __init__(self, seconds: float):
            captured["seconds"] = seconds

        async def __aenter__(self):
            return None

        async def __aexit__(self, _exc_type, _exc, _tb):
            return False

    monkeypatch.setattr(
        "kimi_cli.acp.session.get_current_acp_tool_call_id_or_none",
        lambda: "turn-1/test-tool-call",
    )
    monkeypatch.setattr("kimi_cli.acp.tools.asyncio.timeout", _FakeTimeoutCtx)

    acp_conn = _FakeACPConn()
    terminal = Terminal(shell_tool, acp_conn, "session-1", approval)

    result = await terminal(ShellParams.model_validate({"command": "echo ok", "timeout_s": 9}))

    assert not result.is_error
    assert captured["seconds"] == 9
    assert acp_conn.released_terminal


async def test_terminal_timeout_message_matches_effective_timeout(shell_tool, approval, monkeypatch):
    monkeypatch.setattr(
        "kimi_cli.acp.session.get_current_acp_tool_call_id_or_none",
        lambda: "turn-1/test-tool-call",
    )

    acp_conn = _FakeACPConn(timeout_error=True)
    terminal = Terminal(shell_tool, acp_conn, "session-1", approval)

    result = await terminal(ShellParams.model_validate({"command": "sleep 10", "timeout_s": 7}))

    assert result.is_error
    assert result.message == "Command killed by timeout (7s)"
    assert result.brief == "Killed by timeout (7s)"
    assert acp_conn.killed_terminal
    assert acp_conn.released_terminal
