import asyncio
import importlib
from collections import deque
from typing import Any, cast

import pytest
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from rich.text import Text

from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.wire.types import StatusUpdate, SteerInput, TextPart

shell_visualize = importlib.import_module("kimi_cli.ui.shell.visualize")
_LiveView = shell_visualize._LiveView
_PromptLiveView = shell_visualize._PromptLiveView


@pytest.mark.asyncio
async def test_visualize_uses_prompt_live_view_when_prompt_session_and_steer_are_provided(
    monkeypatch,
) -> None:
    called: list[tuple[str, object, object]] = []
    bound: list[tuple[object, object]] = []
    unbound: list[object] = []

    class _PromptSession:
        def attach_running_prompt(self, delegate) -> None:
            called.append(("attach", delegate, None))

        def detach_running_prompt(self, delegate) -> None:
            called.append(("detach", delegate, None))

    class _DummyPromptLiveView:
        def __init__(self, initial_status, *, prompt_session, steer, cancel_event):
            called.append(("init", initial_status, cancel_event))
            assert prompt_session is not None
            assert steer is not None
            self.handle_local_input = lambda user_input: None

        async def visualize_loop(self, wire) -> None:
            called.append(("loop", wire, None))

    def _unexpected_live_view(*args, **kwargs):
        raise AssertionError("_LiveView should not be used")

    monkeypatch.setattr(shell_visualize, "_PromptLiveView", _DummyPromptLiveView)
    monkeypatch.setattr(shell_visualize, "_LiveView", _unexpected_live_view)

    status = StatusUpdate(context_usage=0.1)
    wire = cast(Any, object())

    await shell_visualize.visualize(
        wire,
        initial_status=status,
        cancel_event=asyncio.Event(),
        prompt_session=cast(Any, _PromptSession()),
        steer=lambda _: None,
        bind_running_input=lambda on_input, on_interrupt: bound.append((on_input, on_interrupt)),
        unbind_running_input=lambda: unbound.append(True),
    )

    assert [entry[0] for entry in called] == ["init", "attach", "loop", "detach"]
    assert called[2] == ("loop", wire, None)
    assert len(bound) == 1
    assert unbound == [True]


def test_render_running_prompt_body_omits_internal_status_block() -> None:
    view = object.__new__(_PromptLiveView)
    view._awaiting_question_other_input = False
    view._turn_ended = False

    calls: list[bool] = []

    def fake_compose(*, include_status: bool = True):
        calls.append(include_status)
        return Text("body")

    view.compose = fake_compose

    rendered = view.render_running_prompt_body(80)

    assert calls == [False]
    assert "body" in rendered.value


def test_running_prompt_hides_placeholder() -> None:
    view = object.__new__(_PromptLiveView)
    view._awaiting_question_other_input = False
    view._turn_ended = False

    assert view.running_prompt_placeholder() is None


def test_live_view_renders_steer_input_as_user_echo(monkeypatch) -> None:
    view = _LiveView(StatusUpdate())
    cleaned: list[bool] = []
    printed: list[str] = []

    monkeypatch.setattr(view, "cleanup", lambda *, is_interrupt: cleaned.append(is_interrupt))
    monkeypatch.setattr(
        shell_visualize.console,
        "print",
        lambda text: printed.append(getattr(text, "plain", str(text))),
    )

    view.dispatch_wire_message(SteerInput(user_input=[TextPart(text="A steer follow-up")]))

    assert cleaned == [False]
    assert printed == ["✨ A steer follow-up"]


def test_live_view_flushes_current_output_before_printing_steer_input(monkeypatch) -> None:
    view = _LiveView(StatusUpdate())
    order: list[object] = []

    monkeypatch.setattr(view, "flush_content", lambda: order.append("flush_content"))
    monkeypatch.setattr(view, "flush_finished_tool_calls", lambda: order.append("flush_tools"))
    monkeypatch.setattr(
        shell_visualize.console,
        "print",
        lambda text: order.append(("print", getattr(text, "plain", str(text)))),
    )

    view.dispatch_wire_message(SteerInput(user_input=[TextPart(text="A steer follow-up")]))

    assert order[:2] == ["flush_content", "flush_tools"]
    assert order[-1] == ("print", "✨ A steer follow-up")


def test_running_prompt_suppresses_duplicate_steer_echo_from_wire(monkeypatch) -> None:
    view = object.__new__(_PromptLiveView)
    view._pending_local_steers = deque([[TextPart(text="A steer follow-up")]])

    forwarded: list[object] = []
    monkeypatch.setattr(
        _LiveView,
        "dispatch_wire_message",
        lambda self, msg: forwarded.append(msg),
    )
    view.dispatch_wire_message(SteerInput(user_input=[TextPart(text="A steer follow-up")]))

    assert list(view._pending_local_steers) == []
    assert forwarded == []


def test_running_prompt_forwards_non_matching_steer_echo_from_wire(monkeypatch) -> None:
    view = object.__new__(_PromptLiveView)
    view._pending_local_steers = deque([[TextPart(text="local steer")]])

    forwarded: list[object] = []
    monkeypatch.setattr(
        _LiveView,
        "dispatch_wire_message",
        lambda self, msg: forwarded.append(msg),
    )
    wire_msg = SteerInput(user_input=[TextPart(text="remote steer")])
    view.dispatch_wire_message(wire_msg)

    assert list(view._pending_local_steers) == [[TextPart(text="local steer")]]
    assert forwarded == [wire_msg]


def test_handle_local_input_echoes_placeholder_display_text_but_steers_expanded_content(
    monkeypatch,
) -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = False
    view._pending_local_steers = deque()
    steered: list[list[TextPart]] = []
    view._steer = lambda content: steered.append(list(content))
    view._flush_prompt_refresh = lambda: None

    printed: list[str] = []
    monkeypatch.setattr(
        shell_visualize.console,
        "print",
        lambda text: printed.append(getattr(text, "plain", str(text))),
    )

    view.handle_local_input(
        UserInput(
            mode=PromptMode.AGENT,
            command="[Pasted text #1 +3 lines]",
            resolved_command="line1\nline2\nline3",
            content=[TextPart(text="line1\nline2\nline3")],
        )
    )

    assert printed == ["✨ [Pasted text #1 +3 lines]"]
    assert steered == [[TextPart(text="line1\nline2\nline3")]]
    assert list(view._pending_local_steers) == [[TextPart(text="line1\nline2\nline3")]]


def test_handle_local_input_ignores_finished_turn(monkeypatch) -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = True
    view._pending_local_steers = deque()
    view._steer = lambda _content: (_ for _ in ()).throw(AssertionError("should not steer"))
    view._flush_prompt_refresh = lambda: None

    printed: list[str] = []
    monkeypatch.setattr(
        shell_visualize.console,
        "print",
        lambda text: printed.append(getattr(text, "plain", str(text))),
    )

    view.handle_local_input(
        UserInput(
            mode=PromptMode.AGENT,
            command="ignored",
            resolved_command="ignored",
            content=[TextPart(text="ignored")],
        )
    )

    assert printed == []
    assert list(view._pending_local_steers) == []


def test_should_prompt_question_other_for_key_shared_helper() -> None:
    view = object.__new__(_PromptLiveView)
    view._current_question_panel = type(
        "_Panel",
        (),
        {
            "is_multi_select": False,
            "should_prompt_other_input": staticmethod(lambda: True),
        },
    )()

    assert view._should_prompt_question_other_for_key(shell_visualize.KeyEvent.ENTER) is True
    assert view._should_prompt_question_other_for_key(shell_visualize.KeyEvent.SPACE) is True

    view._current_question_panel = type(
        "_Panel",
        (),
        {
            "is_multi_select": True,
            "should_prompt_other_input": staticmethod(lambda: True),
        },
    )()

    assert view._should_prompt_question_other_for_key(shell_visualize.KeyEvent.SPACE) is False


def test_submit_question_other_text_resolves_request_when_done() -> None:
    resolved: list[object] = []
    calls: list[str] = []

    class _Request:
        def resolve(self, answers) -> None:
            resolved.append(answers)

    class _Panel:
        request = _Request()

        @staticmethod
        def submit_other(text: str) -> bool:
            calls.append(text)
            return True

        @staticmethod
        def get_answers() -> dict[str, str]:
            return {"q": "custom"}

    view = object.__new__(_PromptLiveView)
    view._current_question_panel = _Panel()
    view.show_next_question_request = lambda: calls.append("next")
    view.refresh_soon = lambda: calls.append("refresh")

    view._submit_question_other_text("custom")

    assert calls == ["custom", "next", "refresh"]
    assert resolved == [{"q": "custom"}]


def test_handle_running_prompt_key_clears_buffer_for_question_panel_actions() -> None:
    view = object.__new__(_PromptLiveView)
    view._awaiting_question_other_input = False
    view._turn_ended = False
    view._current_question_panel = type(
        "_Panel",
        (),
        {
            "is_multi_select": False,
            "should_prompt_other_input": staticmethod(lambda: False),
        },
    )()
    view._current_approval_request_panel = None

    dispatched: list[object] = []
    view.dispatch_keyboard_event = lambda event: dispatched.append(event)
    view._flush_prompt_refresh = lambda: None

    buffer = Buffer(document=Document(text="draft", cursor_position=5))
    event = type("_Event", (), {"current_buffer": buffer})()

    view.handle_running_prompt_key("enter", event)

    assert buffer.text == ""
    assert dispatched == [shell_visualize.KeyEvent.ENTER]


def test_running_prompt_handles_approval_panel_keys_and_clears_buffer() -> None:
    view = object.__new__(_PromptLiveView)
    view._awaiting_question_other_input = False
    view._turn_ended = False
    view._current_question_panel = None
    view._current_approval_request_panel = object()

    dispatched: list[object] = []
    view.dispatch_keyboard_event = lambda event: dispatched.append(event)
    view._flush_prompt_refresh = lambda: None

    buffer = Buffer(document=Document(text="draft", cursor_position=5))
    event = type("_Event", (), {"current_buffer": buffer})()

    assert view.should_handle_running_prompt_key("1") is True

    view.handle_running_prompt_key("down", event)

    assert buffer.text == ""
    assert dispatched == [shell_visualize.KeyEvent.DOWN]


def test_handle_running_prompt_key_clears_buffer_when_exiting_other_input_mode() -> None:
    view = object.__new__(_PromptLiveView)
    view._awaiting_question_other_input = True
    view._turn_ended = False
    view.refresh_soon = lambda: None
    view._flush_prompt_refresh = lambda: None

    buffer = Buffer(document=Document(text="draft", cursor_position=5))
    event = type("_Event", (), {"current_buffer": buffer})()

    view.handle_running_prompt_key("escape", event)

    assert view._awaiting_question_other_input is False
    assert buffer.text == ""
