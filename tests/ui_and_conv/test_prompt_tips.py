from types import SimpleNamespace
from typing import Any, cast

import pytest

from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell import prompt as shell_prompt
from kimi_cli.ui.shell.prompt import (
    PROMPT_SYMBOL,
    CustomPromptSession,
    PromptMode,
    UserInput,
    _build_toolbar_tips,
    _toast_queues,
)


class _DummyRunningPrompt:
    def render_running_prompt_body(self, columns: int) -> str:
        return f"live view ({columns})"

    def running_prompt_placeholder(self) -> None:
        return None

    def should_handle_running_prompt_key(self, key: str) -> bool:
        return key == "enter"

    def handle_running_prompt_key(self, key: str, event) -> None:
        raise AssertionError("Should not be called in this test")


def test_build_toolbar_tips_without_clipboard():
    assert _build_toolbar_tips(clipboard_available=False) == [
        "ctrl-x: toggle mode",
        "shift-tab: plan mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "@: mention files",
    ]


def test_build_toolbar_tips_with_clipboard():
    assert _build_toolbar_tips(clipboard_available=True) == [
        "ctrl-x: toggle mode",
        "shift-tab: plan mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "ctrl-v: paste clipboard",
        "@: mention files",
    ]


def test_bottom_toolbar_no_overflow_when_tip_would_exactly_fill_old_available(monkeypatch) -> None:
    width = 60
    mode_text = "agent"
    right_text = CustomPromptSession._render_right_span(StatusSnapshot(context_usage=0.0))
    tip_len = width - len(mode_text) - len(right_text) - 4

    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._model_name = None
    prompt_session._thinking = False
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._tips = ["t" * tip_len]
    prompt_session._tip_rotation_index = 0

    class _DummyOutput:
        @staticmethod
        def get_size():
            return SimpleNamespace(columns=width)

    dummy_app = SimpleNamespace(output=_DummyOutput())
    monkeypatch.setattr(shell_prompt, "get_app_or_none", lambda: dummy_app)
    _toast_queues["left"].clear()
    _toast_queues["right"].clear()

    rendered = prompt_session._render_bottom_toolbar()
    plain = "".join(fragment[1] for fragment in rendered)
    second_line = plain.split("\n", 1)[1]

    assert len(second_line) <= width


def test_running_prompt_uses_shared_toolbar_and_separator_layout(monkeypatch) -> None:
    width = 72
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._model_name = None
    prompt_session._running_prompt_delegate = _DummyRunningPrompt()
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._thinking = False
    prompt_session._tips = ["tip"]
    prompt_session._tip_rotation_index = 0

    class _DummyOutput:
        @staticmethod
        def get_size():
            return SimpleNamespace(columns=width)

    dummy_app = SimpleNamespace(output=_DummyOutput())
    monkeypatch.setattr(shell_prompt, "get_app_or_none", lambda: dummy_app)

    rendered_message = prompt_session._render_agent_prompt_message()
    plain_message = "".join(fragment[1] for fragment in rendered_message)
    assert plain_message.startswith(f"live view ({width})\n\n")
    assert f"\n{'─' * width}\n" in plain_message
    assert plain_message.endswith(f"{PROMPT_SYMBOL} ")

    rendered_toolbar = prompt_session._render_bottom_toolbar()
    plain_toolbar = "".join(fragment[1] for fragment in rendered_toolbar)
    assert "agent" in plain_toolbar
    assert "tip" in plain_toolbar
    assert "context: 0.0%" in plain_toolbar


def test_idle_agent_prompt_uses_same_separator_layout(monkeypatch) -> None:
    width = 64
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._running_prompt_delegate = None
    prompt_session._status_provider = lambda: StatusSnapshot(context_usage=0.0)
    prompt_session._thinking = False

    class _DummyOutput:
        @staticmethod
        def get_size():
            return SimpleNamespace(columns=width)

    dummy_app = SimpleNamespace(output=_DummyOutput())
    monkeypatch.setattr(shell_prompt, "get_app_or_none", lambda: dummy_app)

    rendered_message = prompt_session._render_agent_prompt_message()
    plain_message = "".join(fragment[1] for fragment in rendered_message)
    assert plain_message.startswith("\n")
    assert f"\n{'─' * width}\n" in plain_message
    assert plain_message.endswith(f"{PROMPT_SYMBOL} ")


def test_apply_mode_syncs_erase_when_done_with_current_mode() -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._session = cast(
        Any,
        SimpleNamespace(
            app=SimpleNamespace(erase_when_done=False),
            default_buffer=SimpleNamespace(completer=None),
        ),
    )
    prompt_session._agent_mode_completer = cast(Any, object())
    prompt_session._shell_mode_completer = cast(Any, object())
    prompt_session._mode = PromptMode.AGENT

    prompt_session._apply_mode()

    assert prompt_session._session.default_buffer.completer is prompt_session._agent_mode_completer
    assert prompt_session._session.app.erase_when_done is True

    prompt_session._mode = PromptMode.SHELL
    prompt_session._apply_mode()

    assert prompt_session._session.default_buffer.completer is prompt_session._shell_mode_completer
    assert prompt_session._session.app.erase_when_done is False


@pytest.mark.asyncio
async def test_prompt_steer_enables_erase_when_done_and_restores_state() -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.SHELL
    prompt_session._running_prompt_delegate = None
    prompt_session._session = cast(Any, SimpleNamespace(app=SimpleNamespace(erase_when_done=False)))

    delegate = _DummyRunningPrompt()
    trace: list[tuple[str, object, object, object]] = []

    def fake_apply_mode(event=None) -> None:
        prompt_session._session.app.erase_when_done = prompt_session._mode == PromptMode.AGENT
        trace.append(
            (
                "apply",
                prompt_session._mode,
                prompt_session._session.app.erase_when_done,
                prompt_session._running_prompt_delegate,
            )
        )

    def fake_invalidate() -> None:
        trace.append(
            (
                "invalidate",
                prompt_session._mode,
                prompt_session._session.app.erase_when_done,
                prompt_session._running_prompt_delegate,
            )
        )

    async def fake_prompt_once(*, append_history: bool) -> UserInput:
        trace.append(
            (
                "prompt",
                append_history,
                prompt_session._session.app.erase_when_done,
                prompt_session._running_prompt_delegate,
            )
        )
        return UserInput(mode=PromptMode.AGENT, command="hi", resolved_command="hi", content=[])

    prompt_session._apply_mode = fake_apply_mode
    prompt_session.invalidate = fake_invalidate
    prompt_session._prompt_once = fake_prompt_once

    result = await prompt_session.prompt_steer(delegate)

    assert result.command == "hi"
    assert prompt_session._mode == PromptMode.SHELL
    assert prompt_session._running_prompt_delegate is None
    assert prompt_session._session.app.erase_when_done is False
    assert ("prompt", False, True, delegate) in trace


@pytest.mark.asyncio
async def test_prompt_steer_restores_state_on_error() -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT
    prompt_session._running_prompt_delegate = None
    prompt_session._session = cast(Any, SimpleNamespace(app=SimpleNamespace(erase_when_done=False)))

    def fake_apply_mode(event=None) -> None:
        prompt_session._session.app.erase_when_done = prompt_session._mode == PromptMode.AGENT
        return None

    def fake_invalidate() -> None:
        return None

    async def fake_prompt_once(*, append_history: bool) -> UserInput:
        raise RuntimeError("boom")

    prompt_session._apply_mode = fake_apply_mode
    prompt_session.invalidate = fake_invalidate
    prompt_session._prompt_once = fake_prompt_once

    with pytest.raises(RuntimeError, match="boom"):
        await prompt_session.prompt_steer(_DummyRunningPrompt())

    assert prompt_session._mode == PromptMode.AGENT
    assert prompt_session._running_prompt_delegate is None
    assert prompt_session._session.app.erase_when_done is True


@pytest.mark.asyncio
@pytest.mark.parametrize("running_prompt", [_DummyRunningPrompt(), None])
async def test_prompt_once_uses_prompt_delegate_placeholder_contract(running_prompt) -> None:
    prompt_session = object.__new__(CustomPromptSession)
    prompt_session._running_prompt_delegate = running_prompt
    prompt_session._tip_rotation_index = 0

    captured: list[object | None] = []

    class _DummySession:
        async def prompt_async(self, **kwargs):
            captured.append(kwargs.get("placeholder"))
            return "hello"

    prompt_session._session = cast(Any, _DummySession())
    prompt_session._build_user_input = lambda command: UserInput(
        mode=PromptMode.AGENT,
        command=command,
        resolved_command=command,
        content=[],
    )

    result = await prompt_session._prompt_once(append_history=False)

    assert result.command == "hello"
    assert captured == [None]
