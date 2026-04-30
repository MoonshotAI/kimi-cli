import asyncio
import importlib
from contextlib import asynccontextmanager, suppress
from typing import Any, cast

import pytest
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from rich.text import Text

from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.wire.types import ApprovalRequest, StatusUpdate, SteerInput, TextPart

shell_visualize = importlib.import_module("kimi_cli.ui.shell.visualize")
# Sub-modules for monkeypatching internal names (Live, _keyboard_listener, console)
_live_view_mod = importlib.import_module("kimi_cli.ui.shell.visualize._live_view")
_interactive_mod = importlib.import_module("kimi_cli.ui.shell.visualize._interactive")
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
        def __init__(
            self,
            initial_status,
            *,
            prompt_session,
            steer,
            btw_runner=None,
            cancel_event,
            show_thinking_stream=False,
        ):
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


def test_render_agent_status_uses_compose_agent_output_not_compose() -> None:
    """render_agent_status() must call compose_agent_output(), NOT compose().

    This ensures approval/question panels are not double-rendered when a modal
    delegate is active (they are rendered in Layer 2 by the modal, not Layer 1).
    """
    view = object.__new__(_PromptLiveView)
    view._turn_ended = False

    agent_calls: list[bool] = []
    compose_calls: list[bool] = []

    def fake_compose_agent_output():
        agent_calls.append(True)
        return [Text("agent-status")]

    def fake_compose(*, include_status: bool = True):
        compose_calls.append(True)
        return Text("full-compose")

    view.compose_agent_output = fake_compose_agent_output
    view.compose = fake_compose

    rendered = view.render_agent_status(80)

    assert agent_calls == [True], "compose_agent_output() should be called"
    assert compose_calls == [], "compose() should NOT be called"
    assert "agent-status" in rendered.value


def test_running_prompt_hides_placeholder() -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = False
    view._current_approval_request_panel = None
    view._current_question_panel = None
    view._btw_modal = None

    assert view.running_prompt_placeholder() is None
    assert view.running_prompt_allows_text_input() is True


def test_running_prompt_shows_approval_placeholder_and_locks_text_input() -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = False
    view._current_question_panel = None
    view._current_approval_request_panel = object()

    placeholder = view.running_prompt_placeholder()

    assert isinstance(placeholder, str)
    assert "1/2/3" in placeholder
    assert view.running_prompt_allows_text_input() is False


def test_running_prompt_allows_text_input_for_question_other_answer() -> None:
    QuestionPromptDelegate = shell_visualize.QuestionPromptDelegate
    panel = type(
        "_Panel",
        (),
        {
            "has_expandable_content": False,
            "is_multi_select": False,
            "should_prompt_other_input": staticmethod(lambda: False),
        },
    )()
    delegate = QuestionPromptDelegate(
        panel,
        on_advance=lambda: None,
        on_invalidate=lambda: None,
    )
    delegate._awaiting_other_input = True

    assert delegate.running_prompt_allows_text_input() is True
    assert delegate.running_prompt_accepts_submission() is True


def test_running_prompt_does_not_accept_submission_after_turn_end_without_panels() -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = True
    view._current_question_panel = None
    view._current_approval_request_panel = None

    assert view.running_prompt_accepts_submission() is False


def test_running_prompt_keeps_accepting_submission_for_active_approval_after_turn_end() -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = True
    view._current_question_panel = None
    view._current_approval_request_panel = object()

    assert view.running_prompt_accepts_submission() is True


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


@pytest.mark.asyncio
async def test_live_view_processes_external_approval_messages(monkeypatch) -> None:
    updates: list[object] = []

    class _FakeLive:
        def __init__(self, *args, **kwargs) -> None:
            self._live_render = type("_Render", (), {"_shape": None})()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> bool:
            return False

        def update(self, renderable, refresh: bool = True) -> None:
            updates.append(renderable)

        def stop(self) -> None:
            return None

        def start(self) -> None:
            return None

    class _Wire:
        async def receive(self):
            await asyncio.Event().wait()

    @asynccontextmanager
    async def _no_keyboard_listener(*args, **kwargs):
        yield

    monkeypatch.setattr(_live_view_mod, "Live", _FakeLive)
    monkeypatch.setattr(_live_view_mod, "_keyboard_listener", _no_keyboard_listener)

    view = _LiveView(StatusUpdate())
    task = asyncio.create_task(view.visualize_loop(cast(Any, _Wire())))
    try:
        await asyncio.sleep(0)
        view.enqueue_external_message(
            ApprovalRequest(
                id="req-ext-1",
                tool_call_id="call-ext-1",
                sender="Shell",
                action="run command",
                description="pwd",
            )
        )
        for _ in range(10):
            if view._current_approval_request_panel is not None:
                break
            await asyncio.sleep(0)
        assert view._current_approval_request_panel is not None
        assert updates
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_prompt_live_view_processes_external_approval_messages() -> None:
    invalidations: list[str] = []

    class _PromptSession:
        def invalidate(self) -> None:
            invalidations.append("invalidate")

    class _Wire:
        async def receive(self):
            await asyncio.Event().wait()

    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(Any, _PromptSession()),
        steer=lambda _content: None,
    )
    task = asyncio.create_task(view.visualize_loop(cast(Any, _Wire())))
    try:
        await asyncio.sleep(0)
        view.enqueue_external_message(
            ApprovalRequest(
                id="req-prompt-ext-1",
                tool_call_id="call-prompt-ext-1",
                sender="WriteFile",
                action="edit file",
                description="Write file `/tmp/bg.txt`",
            )
        )
        for _ in range(10):
            if view._current_approval_request_panel is not None:
                break
            await asyncio.sleep(0)
        assert view._current_approval_request_panel is not None
        assert invalidations
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_prompt_live_view_keeps_processing_external_approvals_after_turn_end() -> None:
    invalidations: list[str] = []
    gate = asyncio.Event()

    class _PromptSession:
        def invalidate(self) -> None:
            invalidations.append("invalidate")

    class _Wire:
        def __init__(self) -> None:
            self._seen_turn_end = False

        async def receive(self):
            if not self._seen_turn_end:
                self._seen_turn_end = True
                return shell_visualize.TurnEnd()
            await gate.wait()
            raise shell_visualize.QueueShutDown

    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(Any, _PromptSession()),
        steer=lambda _content: None,
    )
    task = asyncio.create_task(view.visualize_loop(cast(Any, _Wire())))
    try:
        for _ in range(10):
            if view._turn_ended:
                break
            await asyncio.sleep(0)
        assert view._turn_ended is True

        view.enqueue_external_message(
            ApprovalRequest(
                id="req-prompt-turn-end",
                tool_call_id="call-prompt-turn-end",
                sender="WriteFile",
                action="edit file",
                description="Write file `/tmp/bg.txt`",
            )
        )
        for _ in range(10):
            if view._current_approval_request_panel is not None:
                break
            await asyncio.sleep(0)
        assert view._current_approval_request_panel is not None
        assert invalidations
    finally:
        gate.set()
        await task


@pytest.mark.asyncio
async def test_live_view_reject_does_not_reject_background_requests_from_other_sources() -> None:
    view = _LiveView(StatusUpdate())
    request_one = ApprovalRequest(
        id="req-bg-source-1",
        tool_call_id="call-bg-source-1",
        sender="Shell",
        action="run command",
        description="echo first",
        source_kind="background_agent",
        source_id="task-1",
    )
    request_two = ApprovalRequest(
        id="req-bg-source-2",
        tool_call_id="call-bg-source-2",
        sender="Shell",
        action="run command",
        description="echo second",
        source_kind="background_agent",
        source_id="task-2",
    )

    view.request_approval(request_one)
    view.request_approval(request_two)
    assert view._current_approval_request_panel is not None
    view._current_approval_request_panel.selected_index = 2

    view._submit_approval()

    assert request_one.resolved is True
    assert await request_one.wait() == "reject"
    assert request_two.resolved is False
    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is request_two


@pytest.mark.asyncio
async def test_live_view_reject_does_not_auto_reject_later_requests_from_same_source() -> None:
    view = _LiveView(StatusUpdate())
    request_one = ApprovalRequest(
        id="req-bg-same-source-1",
        tool_call_id="call-bg-same-source-1",
        sender="Shell",
        action="run command",
        description="echo first",
        source_kind="background_agent",
        source_id="task-shared",
    )
    request_two = ApprovalRequest(
        id="req-bg-same-source-2",
        tool_call_id="call-bg-same-source-2",
        sender="Shell",
        action="run command",
        description="echo second",
        source_kind="background_agent",
        source_id="task-shared",
    )

    view.request_approval(request_one)
    assert view._current_approval_request_panel is not None
    view._current_approval_request_panel.selected_index = 2

    view._submit_approval()
    view.request_approval(request_two)

    assert request_two.resolved is False
    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is request_two


@pytest.mark.asyncio
async def test_live_view_approval_num4_selects_feedback_option() -> None:
    """Pressing NUM_4 in _LiveView should select the feedback (4th) approval option."""
    view = _LiveView(StatusUpdate())
    request = ApprovalRequest(
        id="req-num4",
        tool_call_id="call-num4",
        sender="Shell",
        action="run command",
        description="echo hello",
    )
    view.request_approval(request)
    assert view._current_approval_request_panel is not None

    # NUM_4 selects the feedback option (index 3) and submits as "reject"
    view.dispatch_keyboard_event(shell_visualize.KeyEvent.NUM_4)

    assert request.resolved is True
    assert await request.wait() == "reject"


@pytest.mark.asyncio
async def test_approval_prompt_delegate_ctrl_c_rejects_current_request() -> None:
    resolved: list[tuple[str, str]] = []
    request = ApprovalRequest(
        id="req-ctrl-c",
        tool_call_id="call-ctrl-c",
        sender="Shell",
        action="run command",
        description="pwd",
    )
    delegate = shell_visualize.ApprovalPromptDelegate(
        request,
        on_response=lambda req, resp, feedback="": resolved.append((req.id, resp)),
    )

    assert delegate.should_handle_running_prompt_key("c-c") is True
    delegate.handle_running_prompt_key(
        "c-c", type("_Event", (), {"app": None, "current_buffer": Buffer()})()
    )

    assert request.resolved is True
    assert resolved == [("req-ctrl-c", "reject")]


def test_running_prompt_suppresses_local_steer_echo_from_wire(monkeypatch) -> None:
    view = object.__new__(_PromptLiveView)
    view._pending_local_steer_count = 1

    forwarded: list[object] = []
    monkeypatch.setattr(
        _LiveView,
        "dispatch_wire_message",
        lambda self, msg: forwarded.append(msg),
    )
    view.dispatch_wire_message(SteerInput(user_input=[TextPart(text="A steer follow-up")]))

    assert view._pending_local_steer_count == 0
    assert forwarded == []


def test_running_prompt_forwards_non_local_steer_from_wire(monkeypatch) -> None:
    view = object.__new__(_PromptLiveView)
    view._pending_local_steer_count = 0

    forwarded: list[object] = []
    monkeypatch.setattr(
        _LiveView,
        "dispatch_wire_message",
        lambda self, msg: forwarded.append(msg),
    )
    wire_msg = SteerInput(user_input=[TextPart(text="remote steer")])
    view.dispatch_wire_message(wire_msg)

    assert view._pending_local_steer_count == 0
    assert forwarded == [wire_msg]


def test_handle_local_input_queues_message_by_default() -> None:
    from unittest.mock import MagicMock

    view = object.__new__(_PromptLiveView)
    view._turn_ended = False
    view._queued_messages = []
    view._prompt_session = MagicMock()

    user_in = UserInput(
        mode=PromptMode.AGENT,
        command="[Pasted text #1 +3 lines]",
        resolved_command="line1\nline2\nline3",
        content=[TextPart(text="line1\nline2\nline3")],
    )
    view.handle_local_input(user_in)

    # Default Enter queues instead of steering
    assert len(view._queued_messages) == 1
    assert view._queued_messages[0].command == "[Pasted text #1 +3 lines]"


def test_handle_local_input_ignores_finished_turn(monkeypatch) -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = True
    view._queued_messages = []
    view._flush_prompt_refresh = lambda: None

    view.handle_local_input(
        UserInput(
            mode=PromptMode.AGENT,
            command="ignored",
            resolved_command="ignored",
            content=[TextPart(text="ignored")],
        )
    )

    # Turn ended — input should be silently ignored, nothing queued
    assert view._queued_messages == []


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


def test_question_delegate_clears_buffer_for_key_actions() -> None:
    QuestionPromptDelegate = shell_visualize.QuestionPromptDelegate

    submitted: list[bool] = []

    class _Panel:
        has_expandable_content = False
        is_multi_select = False
        is_other_selected = False
        request = type("_Req", (), {"resolve": lambda self, x: None})()

        @staticmethod
        def should_prompt_other_input() -> bool:
            return False

        def submit(self) -> bool:
            submitted.append(True)
            return True

        def get_answers(self) -> dict[str, str]:
            return {}

        def move_up(self) -> None:
            pass

        def move_down(self) -> None:
            pass

        def save_other_draft(self, text: str) -> None:
            pass

        def get_other_draft(self) -> str:
            return ""

    delegate = QuestionPromptDelegate(
        _Panel(),
        on_advance=lambda: None,
        on_invalidate=lambda: None,
    )

    buffer = Buffer(document=Document(text="draft", cursor_position=5))
    event = type("_Event", (), {"current_buffer": buffer})()

    delegate.handle_running_prompt_key("enter", event)

    assert buffer.text == ""
    assert submitted == [True]


def test_running_prompt_handles_approval_panel_keys_and_clears_buffer() -> None:
    view = object.__new__(_PromptLiveView)
    view._turn_ended = False
    view._current_question_panel = None
    view._current_approval_request_panel = object()
    view._btw_modal = None

    dispatched: list[object] = []
    view.dispatch_keyboard_event = lambda event: dispatched.append(event)
    view._flush_prompt_refresh = lambda: None

    buffer = Buffer(document=Document(text="draft", cursor_position=5))
    event = type("_Event", (), {"current_buffer": buffer})()

    assert view.should_handle_running_prompt_key("1") is True

    view.handle_running_prompt_key("down", event)

    assert buffer.text == ""
    assert dispatched == [shell_visualize.KeyEvent.DOWN]


def test_question_delegate_clears_buffer_when_exiting_other_input_mode() -> None:
    QuestionPromptDelegate = shell_visualize.QuestionPromptDelegate

    resolved: list[object] = []

    class _Panel:
        has_expandable_content = False
        is_multi_select = False

        class request:
            @staticmethod
            def resolve(x):
                resolved.append(x)

        @staticmethod
        def should_prompt_other_input() -> bool:
            return False

    advanced: list[bool] = []
    delegate = QuestionPromptDelegate(
        _Panel(),
        on_advance=lambda: (advanced.append(True), None)[-1],
        on_invalidate=lambda: None,
    )
    delegate._awaiting_other_input = True

    buffer = Buffer(document=Document(text="draft", cursor_position=5))
    event = type("_Event", (), {"current_buffer": buffer})()

    delegate.handle_running_prompt_key("escape", event)

    assert delegate._awaiting_other_input is False
    assert buffer.text == ""
    assert resolved == [{}]
    assert advanced == [True]


# ---------------------------------------------------------------------------
# Inline Other input: draft save/restore across navigation
# ---------------------------------------------------------------------------

QuestionRequestPanel = shell_visualize.QuestionRequestPanel
QuestionPromptDelegate = shell_visualize.QuestionPromptDelegate


def _make_two_question_request():
    """Create a QuestionRequest with two single-select questions."""
    from kimi_cli.wire.types import QuestionItem, QuestionOption
    from kimi_cli.wire.types import QuestionRequest as QR

    return QR(
        id="qr-test",
        tool_call_id="tc-test",
        questions=[
            QuestionItem(
                question="Pick a framework",
                header="Q1",
                options=[
                    QuestionOption(label="React"),
                    QuestionOption(label="Vue"),
                ],
            ),
            QuestionItem(
                question="Pick a language",
                header="Q2",
                options=[
                    QuestionOption(label="TypeScript"),
                    QuestionOption(label="JavaScript"),
                ],
            ),
        ],
    )


def _make_delegate_with_panel(panel):
    """Create a QuestionPromptDelegate with a buffer text provider backed by a real Buffer."""
    buf = Buffer()
    delegate = QuestionPromptDelegate(
        panel,
        on_advance=lambda: None,
        on_invalidate=lambda: None,
        buffer_text_provider=lambda: buf.text,
    )
    return delegate, buf


def test_inline_other_draft_survives_up_down_navigation():
    """Type in Other, press UP to leave, press DOWN to return — draft is restored."""
    panel = QuestionRequestPanel(_make_two_question_request())
    delegate, buf = _make_delegate_with_panel(panel)

    # Navigate to Other (last option, index 2)
    panel._selected_index = len(panel._options) - 1
    assert panel.is_other_selected

    # Simulate typing
    buf.set_document(Document(text="my custom answer", cursor_position=16), bypass_readonly=True)

    # Press UP — should save draft and move away
    event = type("_Event", (), {"current_buffer": buf})()
    delegate.handle_running_prompt_key("up", event)

    assert not panel.is_other_selected
    assert buf.text == ""  # buffer cleared

    # Press DOWN — should return to Other and restore draft
    delegate.handle_running_prompt_key("down", event)

    assert panel.is_other_selected
    assert buf.text == "my custom answer"


def test_inline_other_draft_survives_tab_switch():
    """Type in Other on Q1, switch to Q2, switch back — draft is restored."""
    panel = QuestionRequestPanel(_make_two_question_request())
    delegate, buf = _make_delegate_with_panel(panel)

    # Navigate to Other on Q1
    panel._selected_index = len(panel._options) - 1
    assert panel.is_other_selected

    # Simulate typing
    buf.set_document(Document(text="custom framework", cursor_position=16), bypass_readonly=True)

    event = type("_Event", (), {"current_buffer": buf})()

    # Press RIGHT — switch to Q2
    delegate.handle_running_prompt_key("right", event)

    assert panel._current_question_index == 1
    assert buf.text == ""  # buffer cleared on Q2

    # Press LEFT — switch back to Q1
    delegate.handle_running_prompt_key("left", event)

    assert panel._current_question_index == 0
    assert panel.is_other_selected
    assert buf.text == "custom framework"


def test_inline_other_draft_cleared_after_submit():
    """After submitting Other text, the draft should not reappear."""
    panel = QuestionRequestPanel(_make_two_question_request())

    advanced: list[bool] = []
    delegate, buf = _make_delegate_with_panel(panel)
    delegate._on_advance = lambda: (advanced.append(True), None)[-1]

    # Navigate to Other on Q1
    panel._selected_index = len(panel._options) - 1

    # Type and submit
    buf.set_document(Document(text="Svelte", cursor_position=6), bypass_readonly=True)
    event = type("_Event", (), {"current_buffer": buf})()
    delegate.handle_running_prompt_key("enter", event)

    # Q1 should be answered
    assert panel._answers.get("Pick a framework") == "Svelte"
    assert buf.text == ""

    # Verify draft is cleared (check on the panel directly since advance was called)
    assert panel._other_drafts.get(0) is None


def test_question_panel_hides_input_buffer():
    """Question modal should always hide the input buffer, not just when Other is selected."""
    panel = QuestionRequestPanel(_make_two_question_request())
    delegate, _buf = _make_delegate_with_panel(panel)

    # Non-Other selected
    panel._selected_index = 0
    assert not panel.is_other_selected
    assert delegate.running_prompt_hides_input_buffer() is True

    # Other selected
    panel._selected_index = len(panel._options) - 1
    assert panel.is_other_selected
    assert delegate.running_prompt_hides_input_buffer() is True


def test_inline_other_renders_typed_text_in_panel():
    """When Other is selected, the panel renders the buffer text inline."""
    panel = QuestionRequestPanel(_make_two_question_request())
    delegate, buf = _make_delegate_with_panel(panel)

    # Navigate to Other
    panel._selected_index = len(panel._options) - 1

    # Type something
    buf.set_document(Document(text="Solid.js", cursor_position=8), bypass_readonly=True)

    # Render — should contain the typed text
    rendered = delegate.render_running_prompt_body(120)
    import re

    plain = re.sub(r"\x1b\[[^m]*m", "", rendered.value)
    assert "Solid.js" in plain


def test_inline_other_allows_text_input_only_when_other_selected():
    """Text input is only allowed when Other is the selected option."""
    panel = QuestionRequestPanel(_make_two_question_request())
    delegate, _buf = _make_delegate_with_panel(panel)

    # Non-Other: no text input
    panel._selected_index = 0
    assert delegate.running_prompt_allows_text_input() is False

    # Other: text input allowed
    panel._selected_index = len(panel._options) - 1
    assert delegate.running_prompt_allows_text_input() is True


# ---------------------------------------------------------------------------
# Approval inline feedback tests
# ---------------------------------------------------------------------------

ApprovalPromptDelegate = shell_visualize.ApprovalPromptDelegate
ApprovalRequestPanel = shell_visualize.ApprovalRequestPanel


def _make_approval_request(request_id: str = "req-1") -> ApprovalRequest:
    return ApprovalRequest(
        id=request_id,
        tool_call_id=f"call-{request_id}",
        sender="Shell",
        action="run command",
        description="echo hello",
    )


def _make_approval_delegate(request=None):
    """Create an ApprovalPromptDelegate with a real buffer for feedback testing."""
    if request is None:
        request = _make_approval_request()
    buf = Buffer()
    responses: list[tuple[str, str, str]] = []
    delegate = ApprovalPromptDelegate(
        request,
        on_response=lambda req, resp, feedback="": responses.append((req.id, resp, feedback)),
        buffer_state_provider=lambda: (buf.text, buf.cursor_position),
    )
    return delegate, buf, responses


def test_approval_panel_has_four_options():
    """Approval panel should have 4 options: approve, approve_session, reject, reject+feedback."""
    panel = ApprovalRequestPanel(_make_approval_request())
    assert len(panel.options) == 4
    assert panel.options[0][1] == "approve"
    assert panel.options[1][1] == "approve_for_session"
    assert panel.options[2][1] == "reject"
    assert panel.options[3][1] == "reject"


def test_approval_feedback_option_enables_text_input():
    """Selecting option 4 should enable inline text input."""
    delegate, _buf, _ = _make_approval_delegate()

    # Options 0-2: no text input
    for i in range(3):
        delegate._panel.selected_index = i
        assert delegate.running_prompt_allows_text_input() is False

    # Option 3 (feedback): text input enabled
    delegate._panel.selected_index = 3
    assert delegate.running_prompt_allows_text_input() is True
    assert delegate.running_prompt_hides_input_buffer() is True


def test_approval_feedback_renders_inline_input():
    """When feedback option is selected, panel renders typed text inline."""
    delegate, buf, _ = _make_approval_delegate()
    delegate._panel.selected_index = 3

    buf.set_document(Document(text="use a safer command", cursor_position=19), bypass_readonly=True)

    rendered = delegate.render_running_prompt_body(120)
    import re

    plain = re.sub(r"\x1b\[[^m]*m", "", rendered.value)
    assert "use a safer command" in plain
    assert "Type your feedback" in plain


def test_approval_feedback_cursor_markup_in_middle():
    """When the cursor is in the middle, the helper wraps the character under
    it with a reverse-video span — mimicking a terminal's native block cursor."""
    from rich.text import Span

    from kimi_cli.ui.shell.visualize._approval_panel import _render_feedback_with_cursor

    # Cursor at position 2 ("he|llo world" — on the first 'l').
    out = _render_feedback_with_cursor("hello world", 2)
    assert out.plain == "hello world"
    assert Span(2, 3, "reverse") in out.spans

    # Cursor at start.
    out = _render_feedback_with_cursor("hello world", 0)
    assert out.plain == "hello world"
    assert Span(0, 1, "reverse") in out.spans


def test_approval_feedback_cursor_markup_at_end():
    """When the cursor sits past the last character, a trailing block glyph
    is emitted (the reverse-video trick requires a character to invert)."""
    from kimi_cli.ui.shell.visualize._approval_panel import _render_feedback_with_cursor

    assert _render_feedback_with_cursor("abc", 3).plain == "abc\u2588"
    # Past-end cursor (defensive) also falls through to the trailing-block branch.
    assert _render_feedback_with_cursor("abc", 10).plain == "abc\u2588"
    # Empty text.
    assert _render_feedback_with_cursor("", 0).plain == "\u2588"
    # None means "unknown" — same fallback as end-of-text.
    assert _render_feedback_with_cursor("abc", None).plain == "abc\u2588"


def test_approval_feedback_cursor_markup_escapes_rich_metachars():
    """Rich markup tags typed by the user (e.g. ``[bold]``) must render as
    literal text, not be interpreted as styles — ``Text()`` takes plain strings."""
    from rich.text import Span

    from kimi_cli.ui.shell.visualize._approval_panel import _render_feedback_with_cursor

    # The "[bold]" prefix stays verbatim; the reverse-cursor span is still
    # applied around the character under the cursor ('h').
    out = _render_feedback_with_cursor("[bold]hello", 6)
    assert out.plain == "[bold]hello"
    assert Span(6, 7, "reverse") in out.spans


@pytest.mark.asyncio
async def test_approval_feedback_submit_sends_reject_with_text():
    """Enter with text in feedback mode should reject with feedback."""
    delegate, buf, responses = _make_approval_delegate()
    delegate._panel.selected_index = 3

    buf.set_document(Document(text="use rm -i instead", cursor_position=17), bypass_readonly=True)
    event = type("_Event", (), {"current_buffer": buf})()
    delegate.handle_running_prompt_key("enter", event)

    assert len(responses) == 1
    assert responses[0][1] == "reject"
    assert responses[0][2] == "use rm -i instead"
    assert buf.text == ""


def test_approval_feedback_empty_enter_does_not_submit():
    """Enter with empty buffer in feedback mode should not submit."""
    delegate, buf, responses = _make_approval_delegate()
    delegate._panel.selected_index = 3

    event = type("_Event", (), {"current_buffer": buf})()
    delegate.handle_running_prompt_key("enter", event)

    assert len(responses) == 0
    assert not delegate._panel.request.resolved


@pytest.mark.asyncio
async def test_approval_feedback_escape_rejects_without_feedback():
    """Escape in feedback mode should reject without feedback text."""
    delegate, buf, responses = _make_approval_delegate()
    delegate._panel.selected_index = 3
    buf.set_document(Document(text="draft", cursor_position=5), bypass_readonly=True)

    event = type("_Event", (), {"current_buffer": buf})()
    delegate.handle_running_prompt_key("escape", event)

    assert len(responses) == 1
    assert responses[0][1] == "reject"
    assert responses[0][2] == ""
    assert buf.text == ""


def test_approval_feedback_up_navigates_away():
    """UP in feedback mode should navigate to option 3 and clear buffer."""
    delegate, buf, _ = _make_approval_delegate()
    delegate._panel.selected_index = 3
    buf.set_document(Document(text="draft", cursor_position=5), bypass_readonly=True)

    event = type("_Event", (), {"current_buffer": buf})()
    delegate.handle_running_prompt_key("up", event)

    assert delegate._panel.selected_index == 2  # moved to "Reject"
    assert buf.text == ""


def test_approval_number_4_selects_feedback_without_submitting():
    """Pressing 4 should select the feedback option but NOT auto-submit."""
    delegate, buf, responses = _make_approval_delegate()
    event = type("_Event", (), {"current_buffer": buf})()

    delegate.handle_running_prompt_key("4", event)

    assert delegate._panel.selected_index == 3
    assert delegate._is_inline_feedback_active()
    assert len(responses) == 0  # should NOT submit yet


def test_approval_feedback_draft_survives_navigation():
    """Type in feedback, navigate away, navigate back — draft is restored."""
    delegate, buf, _ = _make_approval_delegate()
    delegate._panel.selected_index = 3  # feedback option

    buf.set_document(Document(text="use safer cmd", cursor_position=13), bypass_readonly=True)
    event = type("_Event", (), {"current_buffer": buf})()

    # UP — leave feedback option, draft saved
    delegate.handle_running_prompt_key("up", event)
    assert delegate._panel.selected_index == 2
    assert buf.text == ""
    assert delegate._feedback_draft == "use safer cmd"

    # DOWN — back to feedback option, draft restored
    delegate.handle_running_prompt_key("down", event)
    assert delegate._panel.selected_index == 3
    assert buf.text == "use safer cmd"


@pytest.mark.asyncio
async def test_approval_feedback_draft_cleared_after_submit():
    """After submitting feedback, draft should be cleared."""
    delegate, buf, responses = _make_approval_delegate()
    delegate._panel.selected_index = 3

    buf.set_document(Document(text="do X instead", cursor_position=12), bypass_readonly=True)
    event = type("_Event", (), {"current_buffer": buf})()

    delegate.handle_running_prompt_key("enter", event)

    assert responses[0][2] == "do X instead"
    assert delegate._feedback_draft == ""


def test_approval_feedback_draft_cleared_on_new_request():
    """set_request should clear feedback draft."""
    delegate, buf, _ = _make_approval_delegate()
    delegate._feedback_draft = "old draft"

    delegate.set_request(_make_approval_request("req-new"))
    assert delegate._feedback_draft == ""


# ---------------------------------------------------------------------------
# ApprovalRequest wire-level feedback propagation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approval_request_resolve_carries_feedback():
    """ApprovalRequest.resolve() should store feedback accessible via .feedback property."""
    request = _make_approval_request("req-fb-wire")

    request.resolve("reject", feedback="use a different command")

    assert request.resolved is True
    assert await request.wait() == "reject"
    assert request.feedback == "use a different command"


@pytest.mark.asyncio
async def test_approval_request_resolve_without_feedback_defaults_empty():
    """ApprovalRequest.resolve() without feedback should default to empty string."""
    request = _make_approval_request("req-fb-default")

    request.resolve("approve")

    assert request.resolved is True
    assert request.feedback == ""


@pytest.mark.asyncio
async def test_approval_request_feedback_available_before_wait():
    """Feedback should be readable immediately after resolve, without awaiting wait()."""
    request = _make_approval_request("req-fb-sync")

    request.resolve("reject", feedback="try rm -i instead")

    # feedback is available synchronously, no need to await
    assert request.feedback == "try rm -i instead"
