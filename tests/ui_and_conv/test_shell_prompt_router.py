from __future__ import annotations

import asyncio
from collections import deque
from types import SimpleNamespace
from typing import Any, cast

import pytest

import kimi_cli.ui.shell as shell_module
from kimi_cli.soul import Soul
from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.wire.types import TextPart


def _make_user_input(command: str, *, mode: PromptMode = PromptMode.AGENT) -> UserInput:
    return UserInput(
        mode=mode,
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
        status=SimpleNamespace(context_usage=0.0, context_tokens=0, max_context_tokens=0),
    )


class _FakePromptSession:
    def __init__(self, responses: list[tuple[bool, UserInput | BaseException]]) -> None:
        self._responses = deque(responses)
        self.last_submission_was_running = False

    async def prompt_next(self) -> UserInput:
        if self._responses:
            was_running, response = self._responses.popleft()
            self.last_submission_was_running = was_running
            if isinstance(response, BaseException):
                raise response
            return response
        await asyncio.sleep(3600)
        raise AssertionError("prompt_next should have been cancelled before retry")


@pytest.fixture
def _patched_prompt_router(monkeypatch):
    monkeypatch.setattr(shell_module, "ensure_tty_sane", lambda: None)
    monkeypatch.setattr(shell_module, "ensure_new_line", lambda: None)


@pytest.mark.asyncio
async def test_route_prompt_events_routes_running_submission_directly_to_handler(
    _patched_prompt_router,
) -> None:
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    prompt_session = _FakePromptSession([(True, _make_user_input("follow-up"))])
    idle_events: asyncio.Queue[shell_module._PromptEvent] = asyncio.Queue()
    resume_prompt = asyncio.Event()
    resume_prompt.set()

    received: list[UserInput] = []
    shell._bind_running_input(lambda user_input: received.append(user_input), lambda: None)

    task = asyncio.create_task(
        shell._route_prompt_events(cast(Any, prompt_session), idle_events, resume_prompt)
    )
    try:
        await asyncio.sleep(0.05)
        assert [user_input.command for user_input in received] == ["follow-up"]
        assert idle_events.empty()
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_route_prompt_events_converts_running_keyboard_interrupt_to_cancel_callback(
    _patched_prompt_router,
) -> None:
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    prompt_session = _FakePromptSession([(False, KeyboardInterrupt())])
    idle_events: asyncio.Queue[shell_module._PromptEvent] = asyncio.Queue()
    resume_prompt = asyncio.Event()
    resume_prompt.set()

    cancelled: list[bool] = []
    shell._bind_running_input(lambda _user_input: None, lambda: cancelled.append(True))

    task = asyncio.create_task(
        shell._route_prompt_events(cast(Any, prompt_session), idle_events, resume_prompt)
    )
    try:
        await asyncio.sleep(0.05)
        assert cancelled == [True]
        assert idle_events.empty()
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_route_prompt_events_marks_eof_during_run_and_stops_router(
    _patched_prompt_router,
) -> None:
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    prompt_session = _FakePromptSession([(False, EOFError())])
    idle_events: asyncio.Queue[shell_module._PromptEvent] = asyncio.Queue()
    resume_prompt = asyncio.Event()
    resume_prompt.set()

    cancelled: list[bool] = []
    shell._bind_running_input(lambda _user_input: None, lambda: cancelled.append(True))

    await shell._route_prompt_events(cast(Any, prompt_session), idle_events, resume_prompt)

    assert cancelled == [True]
    assert shell._exit_after_run is True
    assert idle_events.empty()


def test_unbind_running_input_clears_handlers() -> None:
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    shell._bind_running_input(lambda _user_input: None, lambda: None)

    shell._unbind_running_input()

    assert shell._running_input_handler is None
    assert shell._running_interrupt_handler is None


@pytest.mark.asyncio
async def test_ctrl_d_after_agent_run_posts_eof_not_swallowed_by_stale_handler(
    _patched_prompt_router,
) -> None:
    """Regression: if _unbind fails, handlers linger and Ctrl-D during idle is
    misrouted as a running-state EOF, causing the main loop to hang forever."""
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))

    # Gate ensures the second prompt_next (EOFError) only fires after unbind.
    gate = asyncio.Event()

    class _GatedPromptSession:
        def __init__(self) -> None:
            self.call_count = 0
            self.last_submission_was_running = False

        async def prompt_next(self) -> UserInput:
            self.call_count += 1
            if self.call_count == 1:
                self.last_submission_was_running = True
                return _make_user_input("steer-msg")
            await gate.wait()
            self.last_submission_was_running = False
            raise EOFError()

    prompt_session = _GatedPromptSession()
    idle_events: asyncio.Queue[shell_module._PromptEvent] = asyncio.Queue()
    resume_prompt = asyncio.Event()
    resume_prompt.set()

    received: list[UserInput] = []
    shell._bind_running_input(lambda ui: received.append(ui), lambda: None)

    # Let the router process the first (running) response.
    task = asyncio.create_task(
        shell._route_prompt_events(cast(Any, prompt_session), idle_events, resume_prompt)
    )
    await asyncio.sleep(0.05)
    assert len(received) == 1

    # Agent run ends — unbind handlers, just like visualize() does.
    shell._unbind_running_input()
    gate.set()

    # Router continues, hits EOFError. With the bug, it would treat this as a
    # running EOF (set _exit_after_run, return without posting event) because
    # the handler was never cleared. After the fix, it should post "eof".
    await asyncio.wait_for(task, timeout=2.0)

    event = idle_events.get_nowait()
    assert event.kind == "eof"
    assert shell._exit_after_run is False
