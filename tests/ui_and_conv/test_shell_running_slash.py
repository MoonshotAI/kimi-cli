from __future__ import annotations

from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock

import pytest

import kimi_cli.ui.shell as shell_module
from kimi_cli.soul import Soul
from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.utils.slashcmd import SlashCommandCall
from kimi_cli.wire.types import TextPart


def _make_fake_soul():
    return SimpleNamespace(
        name="Test Soul",
        available_slash_commands=[],
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        status=SimpleNamespace(context_usage=0.0, context_tokens=0, max_context_tokens=0),
    )


@pytest.mark.asyncio
async def test_run_soul_command_executes_pending_shell_slash_after_cancel(monkeypatch) -> None:
    """When a shell-level slash command is submitted during streaming, the run is cancelled
    and the slash command is executed afterward."""
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell._run_slash_command = AsyncMock()
    shell._maybe_present_pending_approvals = lambda: None

    # First test: cancellation without pending slash command returns False
    async def fake_run_soul(soul, user_input, ui_loop_fn, cancel_event, wire_file, runtime):
        # Simulate run being cancelled immediately
        from kimi_cli.soul import RunCancelled
        raise RunCancelled()

    monkeypatch.setattr(shell_module, "run_soul", fake_run_soul)
    monkeypatch.setattr(shell_module, "install_sigint_handler", lambda loop, handler: (lambda: None))

    result = await shell.run_soul_command("hello")
    assert result is False
    shell._run_slash_command.assert_not_awaited()

    # Second test: simulate a pending slash command being set during the run
    async def fake_run_soul_with_slash(soul, user_input, ui_loop_fn, cancel_event, wire_file, runtime):
        shell._pending_running_slash_command = SlashCommandCall(
            name="task", args="", raw_input="/task"
        )
        cancel_event.set()
        from kimi_cli.soul import RunCancelled

        raise RunCancelled()

    monkeypatch.setattr(shell_module, "run_soul", fake_run_soul_with_slash)

    result = await shell.run_soul_command("hello")
    assert result is True
    shell._run_slash_command.assert_awaited_once()
    call_args = shell._run_slash_command.await_args.args[0]
    assert call_args.name == "task"
    assert call_args.raw_input == "/task"


@pytest.mark.asyncio
async def test_run_soul_command_pending_slash_after_successful_run(monkeypatch) -> None:
    """If a slash command was queued during a run that finishes normally, it is still
    executed after the run completes."""
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell._run_slash_command = AsyncMock()
    shell._maybe_present_pending_approvals = lambda: None

    async def fake_run_soul(soul, user_input, ui_loop_fn, cancel_event, wire_file, runtime):
        # Simulate callback being triggered during the run
        shell._pending_running_slash_command = SlashCommandCall(
            name="help", args="", raw_input="/help"
        )
        # Run completes normally (no cancel)

    monkeypatch.setattr(shell_module, "run_soul", fake_run_soul)
    monkeypatch.setattr(shell_module, "install_sigint_handler", lambda loop, handler: (lambda: None))

    result = await shell.run_soul_command("hello")
    assert result is True
    shell._run_slash_command.assert_awaited_once()
    call_args = shell._run_slash_command.await_args.args[0]
    assert call_args.name == "help"
