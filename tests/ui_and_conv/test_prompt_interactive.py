from __future__ import annotations

from collections import deque
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock

import pytest

import kimi_cli.ui.shell as shell_module
from kimi_cli.soul import Soul
from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.wire.types import TextPart


class _FakePromptSession:
    instances: list[_FakePromptSession] = []
    responses: deque[UserInput | BaseException] = deque()

    def __init__(self, *args, **kwargs) -> None:
        self.prompt_calls = 0
        self.last_submission_was_running = False
        _FakePromptSession.instances.append(self)

    def __enter__(self) -> _FakePromptSession:
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    async def prompt_next(self) -> UserInput:
        self.prompt_calls += 1
        response = _FakePromptSession.responses.popleft()
        if isinstance(response, BaseException):
            raise response
        return response

    def attach_running_prompt(self, delegate) -> None:
        return None

    def detach_running_prompt(self, delegate) -> None:
        return None

    def invalidate(self) -> None:
        pass


def _make_user_input(command: str) -> UserInput:
    return UserInput(
        mode=PromptMode.AGENT,
        command=command,
        resolved_command=command,
        content=[TextPart(text=command)],
    )


def _make_fake_soul():
    return SimpleNamespace(
        name="Test Soul",
        available_slash_commands=[],
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        status=SimpleNamespace(
            context_usage=0.0,
            context_tokens=0,
            max_context_tokens=0,
            mcp_status=None,
        ),
    )


@pytest.fixture
def _patched_shell_run(monkeypatch):
    _FakePromptSession.instances = []
    _FakePromptSession.responses = deque()
    monkeypatch.setattr(shell_module, "CustomPromptSession", _FakePromptSession)
    monkeypatch.setattr(shell_module, "_print_welcome_info", lambda *args, **kwargs: None)
    monkeypatch.setattr(shell_module, "get_env_bool", lambda name: True)
    monkeypatch.setattr(shell_module, "ensure_tty_sane", lambda: None)
    monkeypatch.setattr(shell_module, "ensure_new_line", lambda: None)

    printed: list[str] = []
    monkeypatch.setattr(
        shell_module.console,
        "print",
        lambda text="": printed.append(getattr(text, "plain", str(text))),
    )
    return printed


@pytest.mark.asyncio
async def test_initial_command_executes_then_enters_interactive_loop(
    monkeypatch, _patched_shell_run
) -> None:
    """--prompt-interactive runs the initial command then keeps the shell open."""
    _FakePromptSession.responses = deque([EOFError()])

    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)

    result = await shell.run(initial_command="hello world")

    assert result is True
    # initial_command should trigger one run_soul_command call
    shell.run_soul_command.assert_awaited_once_with("hello world")
    # After the initial command the loop should wait for user input (EOF)
    assert _FakePromptSession.instances[0].prompt_calls == 1


@pytest.mark.asyncio
async def test_initial_command_failure_still_enters_interactive_loop(
    monkeypatch, _patched_shell_run
) -> None:
    """Even if the initial command fails, the interactive loop continues."""
    _FakePromptSession.responses = deque([EOFError()])

    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=False)

    result = await shell.run(initial_command="fail me")

    assert result is True  # initial command failure should not affect interactive session exit code
    shell.run_soul_command.assert_awaited_once_with("fail me")
    assert _FakePromptSession.instances[0].prompt_calls == 1


@pytest.mark.asyncio
async def test_initial_command_with_exit_stops_immediately(monkeypatch, _patched_shell_run) -> None:
    """If the initial command triggers /exit, the shell exits without prompting."""
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))

    async def _mock_run(cmd):
        shell._exit_after_run = True
        return True

    shell.run_soul_command = AsyncMock(side_effect=_mock_run)

    result = await shell.run(initial_command="/exit")

    assert result is True
    shell.run_soul_command.assert_awaited_once_with("/exit")
    # No prompt calls because we exited immediately
    assert _FakePromptSession.instances[0].prompt_calls == 0
