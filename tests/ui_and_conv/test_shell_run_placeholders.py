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
        _FakePromptSession.instances.append(self)

    def __enter__(self) -> _FakePromptSession:
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    async def prompt(self) -> UserInput:
        self.prompt_calls += 1
        response = _FakePromptSession.responses.popleft()
        if isinstance(response, BaseException):
            raise response
        return response


def _make_user_input(
    command: str,
    *,
    mode: PromptMode = PromptMode.AGENT,
    resolved_command: str | None = None,
) -> UserInput:
    return UserInput(
        mode=mode,
        command=command,
        resolved_command=command if resolved_command is None else resolved_command,
        content=[TextPart(text=command if resolved_command is None else resolved_command)],
    )


def _make_fake_soul():
    return SimpleNamespace(
        name="Test Soul",
        available_slash_commands=[],
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        status=SimpleNamespace(context_usage=0.0, context_tokens=0, max_context_tokens=0),
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
async def test_shell_run_treats_hidden_slash_in_placeholder_as_regular_agent_input(
    monkeypatch, _patched_shell_run
) -> None:
    printed = _patched_shell_run
    _FakePromptSession.responses = deque(
        [
            UserInput(
                mode=PromptMode.AGENT,
                command="[Pasted text #1 +3 lines]",
                resolved_command="/quit\nstill send this",
                content=[TextPart(text="/quit\nstill send this")],
            ),
            EOFError(),
        ]
    )
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)
    shell._run_slash_command = AsyncMock()

    result = await shell.run()

    assert result is True
    assert _FakePromptSession.instances[0].prompt_calls == 2
    shell.run_soul_command.assert_awaited_once_with([TextPart(text="/quit\nstill send this")])
    shell._run_slash_command.assert_not_awaited()
    assert printed == ["✨ [Pasted text #1 +3 lines]", "", "Bye!"]


@pytest.mark.asyncio
async def test_shell_run_dispatches_visible_slash_with_expanded_placeholder_args(
    monkeypatch, _patched_shell_run
) -> None:
    printed = _patched_shell_run
    _FakePromptSession.responses = deque(
        [
            UserInput(
                mode=PromptMode.AGENT,
                command="/fakecmd [Pasted text #1 +3 lines]",
                resolved_command="/fakecmd line1\nline2\nline3",
                content=[TextPart(text="line1\nline2\nline3")],
            ),
            EOFError(),
        ]
    )
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)
    shell._run_slash_command = AsyncMock()

    result = await shell.run()

    assert result is True
    assert _FakePromptSession.instances[0].prompt_calls == 2
    shell.run_soul_command.assert_not_awaited()
    shell._run_slash_command.assert_awaited_once()
    assert shell._run_slash_command.await_args is not None
    command_call = shell._run_slash_command.await_args.args[0]
    assert command_call.name == "fakecmd"
    assert command_call.args == "line1\nline2\nline3"
    assert command_call.raw_input == "/fakecmd line1\nline2\nline3"
    assert printed == ["Bye!"]


@pytest.mark.asyncio
async def test_shell_run_exits_immediately_for_visible_quit_command(
    monkeypatch, _patched_shell_run
) -> None:
    printed = _patched_shell_run
    _FakePromptSession.responses = deque([_make_user_input("/quit")])
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)
    shell._run_slash_command = AsyncMock()

    result = await shell.run()

    assert result is True
    assert _FakePromptSession.instances[0].prompt_calls == 1
    shell.run_soul_command.assert_not_awaited()
    shell._run_slash_command.assert_not_awaited()
    assert printed == ["Bye!"]


@pytest.mark.asyncio
async def test_shell_run_exits_immediately_for_visible_exit_command_in_shell_mode(
    monkeypatch, _patched_shell_run
) -> None:
    printed = _patched_shell_run
    _FakePromptSession.responses = deque([_make_user_input("exit", mode=PromptMode.SHELL)])
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)
    shell._run_shell_command = AsyncMock()
    shell._run_slash_command = AsyncMock()

    result = await shell.run()

    assert result is True
    assert _FakePromptSession.instances[0].prompt_calls == 1
    shell.run_soul_command.assert_not_awaited()
    shell._run_shell_command.assert_not_awaited()
    shell._run_slash_command.assert_not_awaited()
    assert printed == ["Bye!"]


@pytest.mark.asyncio
async def test_shell_run_exits_immediately_for_visible_slash_exit_command_in_shell_mode(
    monkeypatch, _patched_shell_run
) -> None:
    printed = _patched_shell_run
    _FakePromptSession.responses = deque([_make_user_input("/exit", mode=PromptMode.SHELL)])
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)
    shell._run_shell_command = AsyncMock()
    shell._run_slash_command = AsyncMock()

    result = await shell.run()

    assert result is True
    assert _FakePromptSession.instances[0].prompt_calls == 1
    shell.run_soul_command.assert_not_awaited()
    shell._run_shell_command.assert_not_awaited()
    shell._run_slash_command.assert_not_awaited()
    assert printed == ["Bye!"]


@pytest.mark.asyncio
async def test_shell_run_exits_immediately_for_visible_slash_quit_command_in_shell_mode(
    monkeypatch, _patched_shell_run
) -> None:
    printed = _patched_shell_run
    _FakePromptSession.responses = deque([_make_user_input("/quit", mode=PromptMode.SHELL)])
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell.run_soul_command = AsyncMock(return_value=True)
    shell._run_shell_command = AsyncMock()
    shell._run_slash_command = AsyncMock()

    result = await shell.run()

    assert result is True
    assert _FakePromptSession.instances[0].prompt_calls == 1
    shell.run_soul_command.assert_not_awaited()
    shell._run_shell_command.assert_not_awaited()
    shell._run_slash_command.assert_not_awaited()
    assert printed == ["Bye!"]
