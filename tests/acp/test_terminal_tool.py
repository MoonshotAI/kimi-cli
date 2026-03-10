from __future__ import annotations

from typing import Any

import acp
import pytest

from kimi_cli.acp.tools import Terminal
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.shell import Shell
from kimi_cli.tools.shell import Params as ShellParams
from tests.conftest import tool_call_context

pytestmark = pytest.mark.asyncio


class _FakeACPConn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def create_terminal(
        self,
        command: str,
        session_id: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: list[acp.schema.EnvVariable] | None = None,
        output_byte_limit: int | None = None,
        **kwargs: Any,
    ) -> acp.schema.CreateTerminalResponse:
        self.calls.append(
            (
                "create_terminal",
                {
                    "command": command,
                    "session_id": session_id,
                    "args": args,
                    "cwd": cwd,
                    "env": env,
                    "output_byte_limit": output_byte_limit,
                },
            )
        )
        return acp.schema.CreateTerminalResponse(terminal_id="term-1")

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        self.calls.append(("session_update", {"session_id": session_id, "update": update}))

    async def wait_for_terminal_exit(
        self, session_id: str, terminal_id: str, **kwargs: Any
    ) -> acp.schema.WaitForTerminalExitResponse:
        self.calls.append(("wait_for_terminal_exit", {"session_id": session_id, "terminal_id": terminal_id}))
        return acp.schema.WaitForTerminalExitResponse(exit_code=0)

    async def terminal_output(
        self, session_id: str, terminal_id: str, **kwargs: Any
    ) -> acp.schema.TerminalOutputResponse:
        self.calls.append(("terminal_output", {"session_id": session_id, "terminal_id": terminal_id}))
        return acp.schema.TerminalOutputResponse(
            output="ok\n",
            truncated=False,
            exit_status=acp.schema.TerminalExitStatus(exit_code=0),
        )

    async def kill_terminal(self, session_id: str, terminal_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("kill_terminal", {"session_id": session_id, "terminal_id": terminal_id}))
        return {}

    async def release_terminal(self, session_id: str, terminal_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("release_terminal", {"session_id": session_id, "terminal_id": terminal_id}))
        return {}


@pytest.mark.parametrize(
    ("shell_name", "shell_path", "expected_command", "expected_args"),
    [
        ("bash", "/bin/bash", "/bin/bash", ["-c", "echo test"]),
        ("Windows PowerShell", "powershell.exe", "powershell.exe", ["-command", "echo test"]),
    ],
)
async def test_terminal_shell_uses_public_shell_args(
    monkeypatch: pytest.MonkeyPatch,
    approval: Approval,
    environment,
    shell_name: str,
    shell_path: str,
    expected_command: str,
    expected_args: list[str],
):
    from kimi_cli.acp import session as acp_session
    from kimi_cli.utils.environment import Environment
    from kaos.path import KaosPath

    fake_conn = _FakeACPConn()
    env = Environment(
        os_kind=environment.os_kind,
        os_arch=environment.os_arch,
        os_version=environment.os_version,
        shell_name=shell_name,
        shell_path=KaosPath(shell_path),
    )
    shell_tool = Shell(approval, env)
    terminal = Terminal(shell_tool, fake_conn, "session-1", approval)

    monkeypatch.setattr(acp_session, "get_current_acp_tool_call_id_or_none", lambda: "tool-1")

    with tool_call_context("Shell"):
        result = await terminal(ShellParams(command="echo test", timeout=10))

    create_call = next(call for call in fake_conn.calls if call[0] == "create_terminal")
    assert create_call[1]["command"] == expected_command
    assert create_call[1]["args"] == expected_args
    assert ("wait_for_terminal_exit", {"session_id": "session-1", "terminal_id": "term-1"}) in fake_conn.calls
    assert ("terminal_output", {"session_id": "session-1", "terminal_id": "term-1"}) in fake_conn.calls
    assert ("release_terminal", {"session_id": "session-1", "terminal_id": "term-1"}) in fake_conn.calls
    assert result.is_error is False
