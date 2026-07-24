"""
Unit and integration tests for modal lifecycle, priority, and edge cases.

These tests verify the correctness of the modal stack, approval/question
delegate state machines, and Shell routing logic without requiring a real
PTY. They complement the e2e tests by covering edge cases that are hard
to trigger through real terminal interaction.
"""

from __future__ import annotations

import importlib
from typing import Any, cast

import pytest

from kimi_cli.wire.types import ApprovalRequest, ApprovalResponse, QuestionRequest, StatusUpdate

shell_visualize = importlib.import_module("kimi_cli.ui.shell.visualize")
_LiveView = shell_visualize._LiveView
_PromptLiveView = shell_visualize._PromptLiveView
ApprovalPromptDelegate = shell_visualize.ApprovalPromptDelegate
QuestionPromptDelegate = shell_visualize.QuestionPromptDelegate


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakePlaceholderManager:
    """Minimal placeholder manager stub — serialize_for_history is identity."""

    @staticmethod
    def serialize_for_history(text: str) -> str:
        return text


def _make_approval_request(request_id: str = "req-1", **kwargs: Any) -> ApprovalRequest:
    defaults = {
        "id": request_id,
        "tool_call_id": f"call-{request_id}",
        "sender": "Shell",
        "action": "run command",
        "description": f"cmd for {request_id}",
    }
    defaults.update(kwargs)
    return ApprovalRequest(**defaults)


def _make_question_request(
    request_id: str = "qreq-1",
    questions: list[dict[str, Any]] | None = None,
) -> QuestionRequest:
    if questions is None:
        questions = [
            {
                "question": "Pick one?",
                "options": [
                    {"label": "A", "description": ""},
                    {"label": "B", "description": ""},
                ],
            },
        ]
    return QuestionRequest(
        id=request_id,
        tool_call_id=f"call-{request_id}",
        questions=questions,
    )


# ---------------------------------------------------------------------------
# ApprovalRequest.resolve() idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approval_request_resolve_is_idempotent() -> None:
    """Calling resolve() twice on the same request should not raise."""
    request = _make_approval_request()
    request.resolve("approve")
    request.resolve("reject")  # second resolve should be a no-op

    assert request.resolved is True
    result = await request.wait()
    assert result == "approve"  # first resolve wins


@pytest.mark.asyncio
async def test_question_request_resolve_is_idempotent() -> None:
    """Calling resolve() twice on a QuestionRequest should not raise."""
    request = _make_question_request()
    request.resolve({"q": "a"})
    request.resolve({"q": "b"})  # no-op

    assert request.resolved is True
    result = await request.wait()
    assert result == {"q": "a"}


# ---------------------------------------------------------------------------
# _LiveView approval queue
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_live_view_approval_queue_fifo() -> None:
    """Approval requests are shown in FIFO order."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2")
    r3 = _make_approval_request("r3")

    view.request_approval(r1)
    view.request_approval(r2)
    view.request_approval(r3)

    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is r1

    # Resolve r1, advance to r2
    r1.resolve("approve")
    view.show_next_approval_request()
    assert view._current_approval_request_panel.request is r2

    # Resolve r2, advance to r3
    r2.resolve("approve")
    view.show_next_approval_request()
    assert view._current_approval_request_panel.request is r3

    # Resolve r3, queue empty
    r3.resolve("reject")
    view.show_next_approval_request()
    assert view._current_approval_request_panel is None


@pytest.mark.asyncio
async def test_live_view_show_next_skips_already_resolved() -> None:
    """Already-resolved requests in the queue should be skipped."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2")
    r3 = _make_approval_request("r3")

    view.request_approval(r1)
    view.request_approval(r2)
    view.request_approval(r3)

    # Resolve r1 and r2 externally before advancing
    r1.resolve("approve")
    r2.resolve("reject")
    view.show_next_approval_request()

    # Should skip r1 and r2, land on r3
    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is r3


@pytest.mark.asyncio
async def test_live_view_approve_for_session_clears_same_action() -> None:
    """approve_for_session should auto-resolve queued requests with same action."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1", action="run command")
    r2 = _make_approval_request("r2", action="run command")
    r3 = _make_approval_request("r3", action="edit file")  # different action

    view.request_approval(r1)
    view.request_approval(r2)
    view.request_approval(r3)

    # Select "approve_for_session" on r1
    view._current_approval_request_panel.selected_index = 1
    view._submit_approval()

    assert r1.resolved is True
    assert r2.resolved is True
    assert await r2.wait() == "approve_for_session"
    assert r3.resolved is False

    # Next panel should be r3 (since r2 was auto-resolved)
    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is r3


# ---------------------------------------------------------------------------
# _LiveView question queue
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_live_view_question_queue_fifo() -> None:
    """Questions are shown in FIFO order."""
    view = _LiveView(StatusUpdate())
    q1 = _make_question_request("q1")
    q2 = _make_question_request("q2")

    view.request_question(q1)
    view.request_question(q2)

    assert view._current_question_panel is not None
    assert view._current_question_panel.request is q1

    q1.resolve({"q": "a"})
    view.show_next_question_request()
    assert view._current_question_panel is not None
    assert view._current_question_panel.request is q2

    q2.resolve({"q": "b"})
    view.show_next_question_request()
    assert view._current_question_panel is None


@pytest.mark.asyncio
async def test_live_view_question_show_next_skips_resolved() -> None:
    """Already-resolved questions in the queue should be skipped."""
    view = _LiveView(StatusUpdate())
    q1 = _make_question_request("q1")
    q2 = _make_question_request("q2")

    view.request_question(q1)
    view.request_question(q2)

    q1.resolve({})
    q2.resolve({})
    view.show_next_question_request()

    assert view._current_question_panel is None


# ---------------------------------------------------------------------------
# _LiveView cleanup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_rejects_queued_approvals() -> None:
    """cleanup() should resolve queued (not current) approval requests with 'reject',
    and clear the current panel."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2")
    r3 = _make_approval_request("r3")

    view.request_approval(r1)  # r1 becomes current
    view.request_approval(r2)  # r2 queued
    view.request_approval(r3)  # r3 queued

    view.cleanup(is_interrupt=True)

    # r1 was current panel — cleanup sets panel to None but does NOT resolve r1
    assert r1.resolved is False
    # r2 and r3 were in the queue — cleanup resolves them
    assert r2.resolved is True
    assert await r2.wait() == "reject"
    assert r3.resolved is True
    assert await r3.wait() == "reject"
    assert view._current_approval_request_panel is None


@pytest.mark.asyncio
async def test_cleanup_resolves_queued_questions_with_empty() -> None:
    """cleanup() should resolve queued questions with empty dict and clear panel."""
    view = _LiveView(StatusUpdate())
    q1 = _make_question_request("q1")
    q2 = _make_question_request("q2")

    view.request_question(q1)  # q1 becomes current
    view.request_question(q2)  # q2 queued

    view.cleanup(is_interrupt=False)

    # q1 was current — not resolved by cleanup
    assert q1.resolved is False
    # q2 was queued — resolved by cleanup
    assert q2.resolved is True
    assert await q2.wait() == {}
    assert view._current_question_panel is None


@pytest.mark.asyncio
async def test_cleanup_is_idempotent() -> None:
    """Calling cleanup() twice should not raise."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request()

    view.request_approval(r1)
    view.cleanup(is_interrupt=False)
    view.cleanup(is_interrupt=True)  # second cleanup should be fine

    assert view._current_approval_request_panel is None


# ---------------------------------------------------------------------------
# _LiveView reconcile approval requests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_removes_externally_resolved() -> None:
    """_reconcile_approval_requests should filter resolved requests from queue."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2")
    r3 = _make_approval_request("r3")

    view.request_approval(r1)
    view.request_approval(r2)
    view.request_approval(r3)

    # r1 is current, externally resolve r2
    r2.resolve("approve")
    view._reconcile_approval_requests()

    # r1 still current
    assert view._current_approval_request_panel.request is r1
    # Resolve r1, advance should skip r2 and go to r3
    r1.resolve("approve")
    view.show_next_approval_request()
    assert view._current_approval_request_panel.request is r3


@pytest.mark.asyncio
async def test_reconcile_advances_if_current_resolved() -> None:
    """If the currently displayed request is resolved externally, reconcile should advance."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2")

    view.request_approval(r1)
    view.request_approval(r2)

    assert view._current_approval_request_panel.request is r1

    # Externally resolve r1
    r1.resolve("approve")
    view._reconcile_approval_requests()

    # Should have advanced to r2
    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is r2


# ---------------------------------------------------------------------------
# QuestionPromptDelegate lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_question_delegate_advance_to_none() -> None:
    """When on_advance returns None (queue empty), panel should be None."""
    QuestionRequestPanel = shell_visualize.QuestionRequestPanel
    q = _make_question_request()
    panel = QuestionRequestPanel(q)

    advanced_calls: list[bool] = []

    def _on_advance():
        advanced_calls.append(True)
        return None  # queue exhausted

    delegate = QuestionPromptDelegate(
        panel,
        on_advance=_on_advance,
        on_invalidate=lambda: None,
    )

    assert delegate.panel is panel
    assert delegate.running_prompt_accepts_submission() is True

    # Simulate escape → resolve → advance
    q.resolve({})
    delegate._advance()

    assert advanced_calls == [True]
    assert delegate.panel is None
    assert delegate.running_prompt_accepts_submission() is False
    assert delegate.should_handle_running_prompt_key("enter") is False


def test_question_delegate_set_panel_resets_state() -> None:
    """set_panel should clear awaiting_other_input and update the panel."""
    QuestionRequestPanel = shell_visualize.QuestionRequestPanel
    q1 = _make_question_request("q1")
    q2 = _make_question_request("q2")
    panel1 = QuestionRequestPanel(q1)
    panel2 = QuestionRequestPanel(q2)

    delegate = QuestionPromptDelegate(
        panel1,
        on_advance=lambda: None,
        on_invalidate=lambda: None,
    )
    delegate._awaiting_other_input = True

    delegate.set_panel(panel2)

    assert delegate.panel is panel2
    assert delegate._awaiting_other_input is False


# ---------------------------------------------------------------------------
# ApprovalPromptDelegate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approval_delegate_number_keys_direct_select() -> None:
    """Number keys 1/2/3 should directly select and submit."""
    from prompt_toolkit.buffer import Buffer

    for key, expected_idx in [("1", 0), ("2", 1), ("3", 2)]:
        responses: list[tuple[str, str]] = []
        request = _make_approval_request(f"req-{key}")
        delegate = ApprovalPromptDelegate(
            request,
            on_response=lambda req, resp, feedback="", _r=responses: _r.append((req.id, resp)),
        )

        assert delegate.should_handle_running_prompt_key(key) is True
        event = type(
            "_Event",
            (),
            {
                "app": type("_App", (), {"create_background_task": lambda self, x: None})(),
                "current_buffer": Buffer(),
            },
        )()
        delegate.handle_running_prompt_key(key, event)

        assert request.resolved is True
        assert len(responses) == 1
        expected_response = ["approve", "approve_for_session", "reject"][expected_idx]
        assert responses[0][1] == expected_response


def test_approval_delegate_set_request_updates_panel() -> None:
    """set_request should update the internal panel."""
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2", description="new desc")

    delegate = ApprovalPromptDelegate(
        r1,
        on_response=lambda req, resp, feedback="": None,
    )

    assert delegate.request is r1
    delegate.set_request(r2)
    assert delegate.request is r2


def test_approval_delegate_hides_input_buffer() -> None:
    """Approval modal should hide the input buffer."""
    request = _make_approval_request()
    delegate = ApprovalPromptDelegate(
        request,
        on_response=lambda req, resp, feedback="": None,
    )
    assert delegate.running_prompt_hides_input_buffer() is True
    assert delegate.running_prompt_allows_text_input() is False
    assert delegate.running_prompt_accepts_submission() is False


# ---------------------------------------------------------------------------
# Modal priority
# ---------------------------------------------------------------------------


def test_approval_has_higher_priority_than_question() -> None:
    """ApprovalPromptDelegate.modal_priority > QuestionPromptDelegate.modal_priority."""
    assert ApprovalPromptDelegate.modal_priority > QuestionPromptDelegate.modal_priority


def test_modal_stack_returns_highest_priority() -> None:
    """When both approval and question modals are attached, approval wins."""

    # We can't easily construct a full CustomPromptSession, but we can
    # test the _active_modal_delegate logic directly
    QuestionRequestPanel = shell_visualize.QuestionRequestPanel
    q = _make_question_request()
    question_delegate = QuestionPromptDelegate(
        QuestionRequestPanel(q),
        on_advance=lambda: None,
        on_invalidate=lambda: None,
    )
    approval_delegate = ApprovalPromptDelegate(
        _make_approval_request(),
        on_response=lambda req, resp, feedback="": None,
    )

    # Simulate the modal stack
    modal_delegates = [question_delegate, approval_delegate]

    # Replicate _active_modal_delegate logic
    _, active = max(
        enumerate(modal_delegates),
        key=lambda item: (getattr(item[1], "modal_priority", 0), item[0]),
    )
    assert active is approval_delegate

    # Reverse order should give the same result
    modal_delegates = [approval_delegate, question_delegate]
    _, active = max(
        enumerate(modal_delegates),
        key=lambda item: (getattr(item[1], "modal_priority", 0), item[0]),
    )
    assert active is approval_delegate


# ---------------------------------------------------------------------------
# _PromptLiveView question modal management
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prompt_live_view_question_modal_attaches_and_detaches() -> None:
    """
    When a QuestionRequest arrives, _PromptLiveView should create and attach
    a QuestionPromptDelegate modal. When the queue is exhausted, it should detach.
    """
    attached: list[object] = []
    detached: list[object] = []

    class _PromptSession:
        def attach_modal(self, delegate) -> None:
            attached.append(delegate)

        def detach_modal(self, delegate) -> None:
            detached.append(delegate)

        def invalidate(self) -> None:
            pass

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(Any, _PromptSession()),
        steer=lambda _content: None,
    )

    q = _make_question_request()
    view.request_question(q)

    # Modal should be attached
    assert len(attached) == 1
    assert isinstance(attached[0], QuestionPromptDelegate)

    # Resolve the question
    q.resolve({"q": "a"})
    view.show_next_question_request()

    # Modal should be detached
    assert len(detached) == 1
    assert detached[0] is attached[0]


@pytest.mark.asyncio
async def test_prompt_live_view_question_modal_updates_on_advance() -> None:
    """
    When advancing from Q1 to Q2, the existing modal should be updated
    via set_panel rather than detach+attach.
    """
    attached: list[object] = []

    class _PromptSession:
        def attach_modal(self, delegate) -> None:
            attached.append(delegate)

        def detach_modal(self, delegate) -> None:
            pass

        def invalidate(self) -> None:
            pass

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(Any, _PromptSession()),
        steer=lambda _content: None,
    )

    q1 = _make_question_request("q1")
    q2 = _make_question_request("q2")
    view.request_question(q1)
    view.request_question(q2)

    # Only one modal should be attached
    assert len(attached) == 1
    delegate_raw = attached[0]
    assert isinstance(delegate_raw, QuestionPromptDelegate)
    delegate: QuestionPromptDelegate = delegate_raw
    assert delegate.panel is not None
    assert delegate.panel.request is q1

    # Resolve q1, advance to q2
    q1.resolve({"q": "a"})
    view.show_next_question_request()

    # Same modal, updated panel
    assert len(attached) == 1  # no new attach
    assert delegate.panel is not None
    assert delegate.panel.request is q2


# ---------------------------------------------------------------------------
# _PromptLiveView cleanup detaches modal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prompt_live_view_cleanup_clears_panel_but_modal_detached_in_finally() -> None:
    """cleanup() clears _current_question_panel but does NOT detach the modal.
    The modal is detached in visualize_loop's finally block. This test verifies
    the cleanup behavior — modal detach is tested in the visualize_loop tests."""
    detached: list[object] = []

    class _PromptSession:
        def attach_modal(self, delegate) -> None:
            pass

        def detach_modal(self, delegate) -> None:
            detached.append(delegate)

        def invalidate(self) -> None:
            pass

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(Any, _PromptSession()),
        steer=lambda _content: None,
    )

    q = _make_question_request()
    view.request_question(q)
    assert view._question_modal is not None

    view.cleanup(is_interrupt=True)

    assert view._current_question_panel is None
    # cleanup does NOT call _on_question_panel_state_changed, so modal
    # is still attached at this point. The finally block handles detach.
    assert view._question_modal is not None
    assert len(detached) == 0


# ---------------------------------------------------------------------------
# _LiveView compose with panels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compose_includes_approval_panel() -> None:
    """compose() should include the approval panel in its output."""
    view = _LiveView(StatusUpdate())
    request = _make_approval_request()
    view.request_approval(request)

    renderable = view.compose()
    # Just verify it doesn't crash and returns something
    assert renderable is not None


@pytest.mark.asyncio
async def test_compose_includes_question_panel() -> None:
    """compose() should include the question panel in its output."""
    view = _LiveView(StatusUpdate())
    q = _make_question_request()
    view.request_question(q)

    renderable = view.compose()
    assert renderable is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("panel_type", ["approval", "question"])
async def test_compose_panel_rendered_before_tool_calls(panel_type: str) -> None:
    """Approval/question panels must appear before tool call blocks in compose().

    When multiple subagents produce large amounts of output, prompt_toolkit
    truncates the bottom of the rendered content.  Interactive panels must be
    at the top so they stay visible.
    """
    from rich.console import Group
    from rich.panel import Panel

    from kimi_cli.wire.types import ToolCall

    view = _LiveView(StatusUpdate())

    for i in range(5):
        tc = ToolCall(
            id=f"tc-{i}",
            function=ToolCall.FunctionBody(name=f"Tool{i}", arguments="{}"),
        )
        view.append_tool_call(tc)

    if panel_type == "approval":
        view.request_approval(_make_approval_request())
    else:
        view.request_question(_make_question_request())

    renderable = view.compose(include_status=False)
    assert isinstance(renderable, Group)
    first = renderable._renderables[0]
    assert isinstance(first, Panel), (
        f"Expected {panel_type} Panel as first renderable, got {type(first).__name__}"
    )


@pytest.mark.asyncio
async def test_compose_approval_before_question_when_both_present() -> None:
    """When both approval and question panels exist, approval comes first."""
    from rich.console import Group
    from rich.panel import Panel

    from kimi_cli.wire.types import ToolCall

    view = _LiveView(StatusUpdate())

    for i in range(3):
        tc = ToolCall(
            id=f"tc-{i}",
            function=ToolCall.FunctionBody(name=f"Tool{i}", arguments="{}"),
        )
        view.append_tool_call(tc)

    view.request_approval(_make_approval_request())
    view.request_question(_make_question_request())

    renderable = view.compose(include_status=False)
    assert isinstance(renderable, Group)

    panels = [r for r in renderable._renderables if isinstance(r, Panel)]
    assert len(panels) >= 2, "Expected at least 2 Panels (approval + question)"
    # First two panels: approval (yellow border) then question
    assert panels[0] is renderable._renderables[0], "Approval panel must be first overall"
    assert panels[1] is renderable._renderables[1], "Question panel must be second"


# ---------------------------------------------------------------------------
# compose_agent_output / compose_interactive_panels split
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compose_agent_output_excludes_panels() -> None:
    """compose_agent_output() must NOT contain approval/question panels."""
    from rich.panel import Panel

    view = _LiveView(StatusUpdate())
    view.request_approval(_make_approval_request())
    view.request_question(_make_question_request())

    blocks = view.compose_agent_output()
    for block in blocks:
        assert not isinstance(block, Panel), (
            "compose_agent_output() should not include Panel renderables "
            "(approval/question panels belong in compose_interactive_panels)"
        )


@pytest.mark.asyncio
async def test_compose_interactive_panels_includes_both() -> None:
    """compose_interactive_panels() returns approval + question panels."""
    from rich.panel import Panel

    view = _LiveView(StatusUpdate())
    view.request_approval(_make_approval_request())
    view.request_question(_make_question_request())

    panels = view.compose_interactive_panels()
    assert len(panels) == 2
    for p in panels:
        assert isinstance(p, Panel)


@pytest.mark.asyncio
async def test_compose_interactive_panels_empty_when_no_panels() -> None:
    """compose_interactive_panels() returns empty list when no panels."""
    view = _LiveView(StatusUpdate())
    assert view.compose_interactive_panels() == []


@pytest.mark.asyncio
async def test_compose_equals_panels_plus_agent_output() -> None:
    """compose() must be the concatenation of interactive panels + agent output."""
    from rich.console import Group

    from kimi_cli.wire.types import ToolCall

    view = _LiveView(StatusUpdate())
    view.request_approval(_make_approval_request())
    for i in range(2):
        tc = ToolCall(
            id=f"tc-{i}",
            function=ToolCall.FunctionBody(name=f"Tool{i}", arguments="{}"),
        )
        view.append_tool_call(tc)

    panels = view.compose_interactive_panels()
    agent_blocks = view.compose_agent_output()
    full = view.compose(include_status=False)

    assert isinstance(full, Group)
    all_renderables = list(full._renderables)
    expected = panels + agent_blocks
    assert len(all_renderables) == len(expected), (
        f"compose() has {len(all_renderables)} items but panels+agent has {len(expected)}"
    )


@pytest.mark.asyncio
async def test_compose_agent_output_includes_spinners_and_tool_calls() -> None:
    """compose_agent_output() should include spinners and tool call blocks."""
    from rich.spinner import Spinner

    from kimi_cli.wire.types import ToolCall

    view = _LiveView(StatusUpdate())
    view._active_turn_depth = 1  # moon fallback requires active turn

    blocks = view.compose_agent_output()
    assert any(isinstance(b, Spinner) for b in blocks), "Should include spinner"

    # Adding a tool call should replace the moon fallback
    tc = ToolCall(id="tc-1", function=ToolCall.FunctionBody(name="ReadFile", arguments="{}"))
    view.append_tool_call(tc)

    blocks = view.compose_agent_output()
    assert len(blocks) >= 1, "Should include tool call block"


@pytest.mark.asyncio
async def test_render_agent_status_excludes_panels_in_interactive() -> None:
    """In interactive mode, render_agent_status() must not include panels.

    This is the core test for the double-rendering fix: when a modal is
    active, the panel is rendered by the modal in Layer 2, NOT by
    render_agent_status() in Layer 1.
    """
    from rich.spinner import Spinner

    from kimi_cli.ui.shell.visualize import _PromptLiveView

    view = object.__new__(_PromptLiveView)
    view._turn_ended = False
    view._btw_spinner = None
    view._btw_question = None
    view._mcp_loading_spinner = None
    view._mooning_spinner = Spinner("moon", "")
    view._active_turn_depth = 0
    view._compacting_spinner = None
    view._current_content_block = None
    view._tool_call_blocks = {}
    view._current_step_retry = None
    view._live_notification_blocks = cast(
        Any, type("deque", (), {"__iter__": lambda self: iter([])})()
    )

    # Add approval panel to the view (as if wire event arrived)
    view._current_approval_request_panel = cast(
        Any, type("_FakePanel", (), {"render": lambda self, **kw: "APPROVAL_PANEL"})()
    )

    rendered = view.render_agent_status(80)
    assert "APPROVAL_PANEL" not in rendered.value, (
        "render_agent_status() must NOT render approval panels — "
        "that is the modal delegate's responsibility in Layer 2"
    )


# ---------------------------------------------------------------------------
# External message handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_external_approval_response_reconciles_queue() -> None:
    """An ApprovalResponse via external message should reconcile the queue."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")
    r2 = _make_approval_request("r2")

    view.request_approval(r1)
    view.request_approval(r2)

    assert view._current_approval_request_panel.request is r1

    # Externally resolve r1
    r1.resolve("approve")
    view.dispatch_wire_message(ApprovalResponse(request_id="r1", response="approve"))

    # Should advance to r2
    assert view._current_approval_request_panel is not None
    assert view._current_approval_request_panel.request is r2


# ---------------------------------------------------------------------------
# Edge: approval request with same id queued twice
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_same_request_object_queued_twice_is_in_queue() -> None:
    """_LiveView.request_approval does not dedup — the same object is queued again.
    Deduplication happens at the Shell level (_queue_approval_request)."""
    view = _LiveView(StatusUpdate())
    r1 = _make_approval_request("r1")

    view.request_approval(r1)
    view.request_approval(r1)

    # r1 is current panel, second r1 is in queue
    assert view._current_approval_request_panel.request is r1
    assert len(view._approval_request_queue) == 1


# ===========================================================================
# Shell approval routing: external resolve, sink fallback, question isolation
# ===========================================================================


@pytest.mark.asyncio
async def test_shell_external_approval_response_syncs_modal(
    runtime,
    tmp_path,
) -> None:
    """When an ApprovalResponse arrives via root_wire_hub (e.g. web UI),
    the Shell should resolve the currently displayed modal and advance
    to the next request."""
    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.approval_runtime import ApprovalSource
    from kimi_cli.soul.agent import Agent
    from kimi_cli.soul.context import Context
    from kimi_cli.soul.kimisoul import KimiSoul
    from kimi_cli.ui.shell import Shell

    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "h.jsonl"))
    shell = Shell(soul)

    # Create two approval requests in the runtime
    runtime.approval_runtime.create_request(
        request_id="ext-r1",
        tool_call_id="c1",
        sender="Shell",
        action="run command",
        description="cmd1",
        display=[],
        source=ApprovalSource(kind="background_agent", id="t1"),
    )
    runtime.approval_runtime.create_request(
        request_id="ext-r2",
        tool_call_id="c2",
        sender="Shell",
        action="run command",
        description="cmd2",
        display=[],
        source=ApprovalSource(kind="background_agent", id="t2"),
    )

    attached: list[object] = []
    invalidations: list[str] = []

    class _PromptSession:
        def attach_modal(self, delegate) -> None:
            attached.append(delegate)

        def detach_modal(self, delegate) -> None:
            pass

        def invalidate(self) -> None:
            invalidations.append("inv")

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    shell._prompt_session = _PromptSession()  # type: ignore[attr-defined]

    # Send both requests
    req1 = ApprovalRequest(
        id="ext-r1",
        tool_call_id="c1",
        sender="Shell",
        action="run command",
        description="cmd1",
        source_kind="background_agent",
        source_id="t1",
    )
    req2 = ApprovalRequest(
        id="ext-r2",
        tool_call_id="c2",
        sender="Shell",
        action="run command",
        description="cmd2",
        source_kind="background_agent",
        source_id="t2",
    )
    await shell._handle_root_hub_message(req1)  # type: ignore[attr-defined]
    await shell._handle_root_hub_message(req2)  # type: ignore[attr-defined]

    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    assert shell._approval_modal.request.id == "ext-r1"  # type: ignore[attr-defined]

    # External resolution (web UI resolves ext-r1)
    runtime.approval_runtime.resolve("ext-r1", "approve")
    await shell._handle_root_hub_message(  # type: ignore[attr-defined]
        ApprovalResponse(request_id="ext-r1", response="approve")
    )

    # Modal should have advanced to ext-r2
    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    assert shell._approval_modal.request.id == "ext-r2"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_shell_forward_approval_to_sink_fallback_when_no_sink(
    runtime,
    tmp_path,
) -> None:
    """When _forward_approval_to_sink is called but sink is None, request
    should fall back to the pending queue."""
    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.approval_runtime import ApprovalSource
    from kimi_cli.soul.agent import Agent
    from kimi_cli.soul.context import Context
    from kimi_cli.soul.kimisoul import KimiSoul
    from kimi_cli.ui.shell import Shell

    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "h.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="fb-r1",
        tool_call_id="c1",
        sender="Shell",
        action="run command",
        description="cmd",
        display=[],
        source=ApprovalSource(kind="background_agent", id="t1"),
    )

    request = ApprovalRequest(
        id="fb-r1",
        tool_call_id="c1",
        sender="Shell",
        action="run command",
        description="cmd",
        source_kind="background_agent",
        source_id="t1",
    )

    # No sink, no prompt_session — forward should fall back to queue
    shell._forward_approval_to_sink(request)  # type: ignore[attr-defined]

    assert list(shell._pending_approval_requests) == [request]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_prompt_live_view_question_does_not_affect_should_handle_key() -> None:
    """After refactoring, _PromptLiveView.should_handle_running_prompt_key
    should NOT handle question-related keys (tab, space, left, right).
    Those are now handled by the QuestionPromptDelegate modal."""
    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(
            Any,
            type(
                "_PS",
                (),
                {
                    "attach_modal": lambda self, d: None,
                    "detach_modal": lambda self, d: None,
                    "invalidate": lambda self: None,
                    "_get_placeholder_manager": lambda self: _FakePlaceholderManager(),
                },
            )(),
        ),
        steer=lambda _: None,
    )

    q = _make_question_request()
    view.request_question(q)

    # _PromptLiveView itself should NOT handle question keys
    assert view.should_handle_running_prompt_key("tab") is False
    assert view.should_handle_running_prompt_key("space") is False
    assert view.should_handle_running_prompt_key("left") is False
    assert view.should_handle_running_prompt_key("right") is False

    # But the delegate (attached as modal) SHOULD handle them
    assert view._question_modal is not None
    assert view._question_modal.should_handle_running_prompt_key("enter") is True
    assert view._question_modal.should_handle_running_prompt_key("up") is True
    assert view._question_modal.should_handle_running_prompt_key("down") is True


@pytest.mark.asyncio
async def test_prompt_live_view_render_body_no_awaiting_other_hint() -> None:
    """After refactoring, _PromptLiveView.render_running_prompt_body should
    NOT contain 'Enter the custom answer' hint. That hint is now rendered
    by the QuestionPromptDelegate, not _PromptLiveView."""
    view = _PromptLiveView(
        StatusUpdate(),
        prompt_session=cast(
            Any,
            type(
                "_PS",
                (),
                {
                    "attach_modal": lambda self, d: None,
                    "detach_modal": lambda self, d: None,
                    "invalidate": lambda self: None,
                    "_get_placeholder_manager": lambda self: _FakePlaceholderManager(),
                },
            )(),
        ),
        steer=lambda _: None,
    )

    q = _make_question_request()
    view.request_question(q)

    rendered = view.render_running_prompt_body(120)
    assert "custom answer" not in rendered.value.lower()
    assert "Enter the custom answer" not in rendered.value


@pytest.mark.asyncio
async def test_question_delegate_on_invalidate_called_on_key_press() -> None:
    """on_invalidate callback should be called when a key modifies state."""
    QuestionRequestPanel = shell_visualize.QuestionRequestPanel
    q = _make_question_request(
        questions=[
            {
                "question": "Q?",
                "options": [
                    {"label": "A", "description": ""},
                    {"label": "B", "description": ""},
                ],
            },
        ]
    )
    panel = QuestionRequestPanel(q)

    invalidations: list[bool] = []

    delegate = QuestionPromptDelegate(
        panel,
        on_advance=lambda: None,
        on_invalidate=lambda: invalidations.append(True),
    )

    from prompt_toolkit.buffer import Buffer

    event = type("_Event", (), {"current_buffer": Buffer()})()

    # Press "1" — should select and submit, calling on_invalidate
    delegate.handle_running_prompt_key("1", event)

    assert len(invalidations) >= 1


# ===========================================================================
# Shell.run(command=...) starts root_wire_hub watcher
# ===========================================================================


@pytest.mark.asyncio
async def test_shell_command_mode_starts_root_wire_hub_watcher(
    runtime,
    tmp_path,
) -> None:
    """Shell.run(command=...) must start _watch_root_wire_hub so that
    approval requests emitted through the root hub are delivered to the
    visualize live view.  Without this, approval-gated tools block
    indefinitely in --command mode."""
    from unittest.mock import AsyncMock

    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.soul.agent import Agent
    from kimi_cli.soul.context import Context
    from kimi_cli.soul.kimisoul import KimiSoul
    from kimi_cli.ui.shell import Shell

    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "h.jsonl"))
    shell = Shell(soul)

    # Mock run_soul_command so we don't need a real LLM
    shell.run_soul_command = AsyncMock(return_value=True)

    hub = runtime.root_wire_hub
    assert len(hub._queue._queues) == 0, "no subscribers before run"

    await shell.run(command="hello")

    shell.run_soul_command.assert_awaited_once_with("hello")
    # After run completes, background tasks are cleaned up
    assert len(hub._queue._queues) == 0, "subscriber cleaned up after run"


@pytest.mark.asyncio
async def test_clear_active_approval_sink_requeues_pending_requests(
    runtime,
    tmp_path,
) -> None:
    """When the live view closes, any approval requests that were forwarded
    to the sink but not yet resolved must be re-queued so they can be
    presented in the next turn or via the prompt modal."""
    from kosong.tooling.empty import EmptyToolset

    from kimi_cli.approval_runtime import ApprovalSource
    from kimi_cli.soul.agent import Agent
    from kimi_cli.soul.context import Context
    from kimi_cli.soul.kimisoul import KimiSoul
    from kimi_cli.ui.shell import Shell

    agent = Agent(
        name="Test",
        system_prompt="test",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "h.jsonl"))
    shell = Shell(soul)

    # Create a pending approval in the runtime
    runtime.approval_runtime.create_request(
        request_id="sink-r1",
        tool_call_id="c1",
        sender="Shell",
        action="run command",
        description="cmd1",
        display=[],
        source=ApprovalSource(kind="background_agent", id="t1"),
    )

    # Simulate: sink was active, request was forwarded (not queued)
    assert len(shell._pending_approval_requests) == 0  # type: ignore[attr-defined]

    # Now the live view closes
    shell._clear_active_view()  # type: ignore[attr-defined]

    # The pending request should have been re-queued
    pending_ids = [r.id for r in shell._pending_approval_requests]  # type: ignore[attr-defined]
    assert "sink-r1" in pending_ids

    # Already-resolved requests should NOT be re-queued
    runtime.approval_runtime.resolve("sink-r1", "approve")
    shell._pending_approval_requests.clear()  # type: ignore[attr-defined]
    shell._clear_active_view()  # type: ignore[attr-defined]
    assert len(shell._pending_approval_requests) == 0  # type: ignore[attr-defined]
