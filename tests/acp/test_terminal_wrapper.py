"""Tests for the ACP `Terminal` wrapper that replaces the local `Shell` tool.

The wrapper must build a spec-compliant `terminal/create` payload — the shell
line cannot be passed as the bare `command` field. ACP clients exec the
request as `Command::new(req.command).args(req.args)`, so packing a multi-
token line into `command` produces a "No such file or directory" failure
when the client looks up a binary literally named `<full shell line>`.

This test locks the contract: `Terminal` must wrap the raw command in
`bash -c` (or `pwsh -command`) the same way the local `Shell` tool does
when running locally — so the same shell-line semantics apply over ACP.
"""

from __future__ import annotations

import platform
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from kimi_cli.acp.tools import Terminal
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.shell import Params, Shell
from tests.conftest import tool_call_context

pytestmark = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="POSIX-only — exercises the `bash -c` branch end-to-end. "
    "PowerShell argv build is verified separately by "
    "`test_terminal_wraps_powershell_branch_argv` below, which runs "
    "on every platform.",
)


def _approve_always() -> AsyncMock:
    """Approval mock that always allows."""

    class _OK:
        def __bool__(self) -> bool:
            return True

        def rejection_error(self) -> Any:
            return None

    return AsyncMock(return_value=_OK())


def _terminal_response(terminal_id: str = "term-001") -> MagicMock:
    resp = MagicMock()
    resp.terminal_id = terminal_id
    return resp


def _exit_response(exit_code: int = 0) -> MagicMock:
    exit_status = MagicMock()
    exit_status.exit_code = exit_code
    exit_status.signal = None
    return exit_status


def _output_response(output: str = "", truncated: bool = False) -> MagicMock:
    out = MagicMock()
    out.output = output
    out.truncated = truncated
    out.exit_status = _exit_response()
    return out


def _make_acp_conn() -> MagicMock:
    """Mock acp.Client capturing every method we exercise."""
    conn = MagicMock()
    conn.create_terminal = AsyncMock(return_value=_terminal_response())
    conn.session_update = AsyncMock(return_value=None)
    conn.wait_for_terminal_exit = AsyncMock(return_value=_exit_response())
    conn.terminal_output = AsyncMock(return_value=_output_response())
    conn.release_terminal = AsyncMock(return_value=None)
    return conn


async def _invoke_terminal(
    shell_tool: Shell, command: str, *, monkeypatch: pytest.MonkeyPatch
) -> tuple[MagicMock, Any]:
    # Patch `get_current_acp_tool_call_id_or_none` to return a deterministic id
    # so the assertion in `Terminal.__call__` succeeds.
    import kimi_cli.acp.session as acp_session

    monkeypatch.setattr(
        acp_session,
        "get_current_acp_tool_call_id_or_none",
        lambda: "test-tool-call-id",
    )

    approval = MagicMock(spec=Approval)
    approval.request = _approve_always()

    conn = _make_acp_conn()
    terminal = Terminal(
        shell_tool=shell_tool,
        acp_conn=cast(Any, conn),
        acp_session_id="test-session",
        approval=approval,
    )
    with tool_call_context("Shell"):
        result = await terminal(Params(command=command))
    return conn, result


@pytest.mark.parametrize(
    "command",
    [
        "git rev-parse --short HEAD",
        'python3 -c "print(7*8)"',
        "cat README.md | head -5",
        "echo hello",
        "pwd",
    ],
    ids=["multi-token", "quoted", "piped", "two-token", "single-token"],
)
async def test_terminal_wraps_command_in_shell(
    shell_tool: Shell,
    command: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`Terminal` must hand off the raw shell line to bash/pwsh, not to the
    client's exec.

    Without the wrap, `Command::new("git rev-parse --short HEAD")` on the
    client side fails because no binary by that literal name exists. With
    the wrap, the same command string is interpreted by the user's shell —
    matching the local Shell tool's behavior.
    """
    conn, _ = await _invoke_terminal(shell_tool, command, monkeypatch=monkeypatch)

    conn.create_terminal.assert_awaited_once()
    call_kwargs = conn.create_terminal.await_args.kwargs

    # `command` must be the shell binary path (e.g. /bin/bash), NOT the raw
    # shell line. This is the regression guard: any change that re-routes
    # `params.command` directly into the `command` field will fail here.
    assert call_kwargs["command"] == str(shell_tool._shell_path)

    # `args` must be the shell-eval pair: ["-c", "<full shell line>"] on
    # POSIX (the PowerShell branch is "-command", covered by the local
    # Shell tool's powershell-only test path).
    assert call_kwargs["args"] == ["-c", command]


async def test_shell_argv_helper_matches_local_run(shell_tool: Shell) -> None:
    """`Shell.shell_argv` is the public seam the ACP `Terminal` reuses;
    its output must match what the local Shell tool actually exec()s, so
    behavior is identical across modes. If this drifts, the ACP and local
    paths will diverge silently.
    """
    cmd = 'echo "spaces and quotes"'
    argv = shell_tool.shell_argv(cmd)
    assert argv[0] == str(shell_tool._shell_path)
    if shell_tool._is_powershell:
        assert argv[1] == "-command"
    else:
        assert argv[1] == "-c"
    assert argv[2] == cmd


# ─── PowerShell-branch coverage (runs on every platform) ───────────────────
#
# The parametrized POSIX cases above can't reach the `is_powershell` branch
# even when run on Windows, because the `shell_tool` fixture in
# `tests/conftest.py` is environment-derived. We flip the flag explicitly so
# the `-command` argv build is verified end-to-end through the same
# `Terminal.__call__` path the parametrized cases exercise — without spinning
# up a real PowerShell process. Lock this; without it, a future regression
# that sends `params.command` raw on the PowerShell branch would slip
# through CI.

@pytest.mark.skipif(
    platform.system() == "Windows",
    reason=(
        "`shell_tool` fixture builds a Bash Shell on POSIX; we monkey-patch "
        "_is_powershell to exercise the `-command` argv branch. On Windows "
        "the fixture already builds a PowerShell Shell and the parametrized "
        "POSIX cases don't run, so this test would be redundant."
    ),
)
async def test_terminal_wraps_powershell_branch_argv(
    shell_tool: Shell,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ACP `Terminal` must use `pwsh -command <line>` (not `bash -c`) when
    the underlying Shell tool reports a PowerShell host. Same wrap shape as
    POSIX, different flag — the ACP client still sees a proper
    program/argv split."""
    monkeypatch.setattr(shell_tool, "_is_powershell", True)
    cmd = 'Get-ChildItem | Select-Object -First 3'

    conn, _ = await _invoke_terminal(shell_tool, cmd, monkeypatch=monkeypatch)

    conn.create_terminal.assert_awaited_once()
    call_kwargs = conn.create_terminal.await_args.kwargs
    assert call_kwargs["command"] == str(shell_tool._shell_path)
    # Critical: `-command`, not `-c`.
    assert call_kwargs["args"] == ["-command", cmd]
