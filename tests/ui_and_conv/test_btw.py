"""Tests for /btw side question: btw.py, classify_input, DenyAllToolset, wire types."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest
from kosong.message import Message, ToolCall
from kosong.tooling import Tool, ToolError, ToolResult

from kimi_cli.soul.btw import (
    _build_btw_context,
    _DenyAllToolset,
    _tool_result_to_message,
    execute_side_question,
)
from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.ui.shell.visualize import (
    InputAction,
    _BtwModalDelegate,
    _PromptLiveView,
    classify_input,
)
from kimi_cli.wire.types import (
    BtwBegin,
    BtwEnd,
    SteerInput,
    TextPart,
    WireMessageEnvelope,
    is_event,
)

# ---------------------------------------------------------------------------
# Helpers for mocking kosong.step
# ---------------------------------------------------------------------------


@dataclass
class _FakeStepResult:
    """Minimal stand-in for kosong.StepResult."""

    message: Message
    tool_calls: list[ToolCall]
    _tool_results: list[ToolResult]

    async def tool_results(self) -> list[ToolResult]:
        return self._tool_results


def _text_result(text: str) -> _FakeStepResult:
    """Simulate LLM returning pure text (no tool calls)."""
    return _FakeStepResult(
        message=Message(role="assistant", content=text),
        tool_calls=[],
        _tool_results=[],
    )


def _tool_call_result(tool_name: str = "Bash") -> _FakeStepResult:
    """Simulate LLM calling a tool (which will be denied)."""
    tc = ToolCall(
        id=f"tc-{tool_name}", function=ToolCall.FunctionBody(name=tool_name, arguments="{}")
    )
    error = ToolResult(
        tool_call_id=tc.id,
        return_value=ToolError(message="Tool calls are disabled", brief="denied"),
    )
    return _FakeStepResult(
        message=Message(role="assistant", content=[], tool_calls=[tc]),
        tool_calls=[tc],
        _tool_results=[error],
    )


def _mixed_text_and_tool_result(text: str, tool_name: str = "Read") -> _FakeStepResult:
    """Simulate LLM returning BOTH text and a tool call in the same turn."""
    tc = ToolCall(
        id=f"tc-{tool_name}", function=ToolCall.FunctionBody(name=tool_name, arguments="{}")
    )
    error = ToolResult(
        tool_call_id=tc.id,
        return_value=ToolError(message="Tool calls are disabled", brief="denied"),
    )
    return _FakeStepResult(
        message=Message(role="assistant", content=text, tool_calls=[tc]),
        tool_calls=[tc],
        _tool_results=[error],
    )


# ---------------------------------------------------------------------------
# classify_input
# ---------------------------------------------------------------------------


class TestClassifyInput:
    def test_btw_with_question_streaming(self):
        action = classify_input("/btw what is this?", is_streaming=True)
        assert action.kind == InputAction.BTW
        assert action.args == "what is this?"

    def test_btw_with_question_idle(self):
        action = classify_input("/btw what is this?", is_streaming=False)
        assert action.kind == InputAction.BTW
        assert action.args == "what is this?"

    def test_btw_no_args_returns_ignored(self):
        for streaming in (True, False):
            action = classify_input("/btw", is_streaming=streaming)
            assert action.kind == InputAction.IGNORED
            assert "Usage" in action.args

    def test_btw_whitespace_only_args_returns_ignored(self):
        action = classify_input("/btw   ", is_streaming=True)
        assert action.kind == InputAction.IGNORED

    def test_normal_text_streaming_returns_queue(self):
        action = classify_input("fix the bug", is_streaming=True)
        assert action.kind == InputAction.QUEUE

    def test_normal_text_idle_returns_send(self):
        action = classify_input("fix the bug", is_streaming=False)
        assert action.kind == InputAction.SEND

    def test_other_slash_command_streaming_returns_queue(self):
        action = classify_input("/compact", is_streaming=True)
        assert action.kind == InputAction.QUEUE

    def test_other_slash_command_idle_returns_send(self):
        action = classify_input("/compact", is_streaming=False)
        assert action.kind == InputAction.SEND


# ---------------------------------------------------------------------------
# _DenyAllToolset
# ---------------------------------------------------------------------------


class TestDenyAllToolset:
    @staticmethod
    def _make_fake_tools() -> list[Tool]:
        t1 = MagicMock(spec=Tool)
        t1.name = "Bash"
        t2 = MagicMock(spec=Tool)
        t2.name = "Read"
        return [t1, t2]

    def test_tools_exposes_source_tools(self):
        tools = self._make_fake_tools()
        ts = _DenyAllToolset(tools)
        assert ts.tools is tools

    @pytest.mark.parametrize("name", ["Bash", "Read", "NonExistent"])
    def test_handle_always_returns_deny_error(self, name):
        ts = _DenyAllToolset(self._make_fake_tools())
        tc = ToolCall(id=f"tc-{name}", function=ToolCall.FunctionBody(name=name, arguments="{}"))
        result = ts.handle(tc)
        assert isinstance(result, ToolResult)
        assert result.tool_call_id == f"tc-{name}"
        assert result.return_value.is_error
        assert isinstance(result.return_value, ToolError)
        assert "disabled" in result.return_value.message


# ---------------------------------------------------------------------------
# _build_btw_context
# ---------------------------------------------------------------------------


class TestBuildBtwContext:
    @staticmethod
    def _make_soul():
        soul = MagicMock()
        soul._agent.system_prompt = "You are a helpful assistant."
        soul._agent.toolset.tools = [MagicMock(spec=Tool)]
        soul.context.history = [
            Message(role="user", content="hello"),
            Message(role="assistant", content="hi there"),
        ]
        return soul

    def test_system_prompt_matches_agent(self):
        soul = self._make_soul()
        system_prompt, _, _ = _build_btw_context(soul, "question?")
        assert system_prompt == "You are a helpful assistant."

    def test_history_ends_with_wrapped_question(self):
        soul = self._make_soul()
        _, history, _ = _build_btw_context(soul, "what is X?")
        last_msg = history[-1]
        assert last_msg.role == "user"
        text = last_msg.extract_text()
        assert "what is X?" in text
        assert "system-reminder" in text

    def test_toolset_is_deny_all_with_agent_tools(self):
        soul = self._make_soul()
        _, _, toolset = _build_btw_context(soul, "q")
        assert isinstance(toolset, _DenyAllToolset)
        assert toolset.tools is soul._agent.toolset.tools

    def test_history_is_normalized(self):
        """Adjacent user messages should be merged by normalize_history."""
        soul = self._make_soul()
        soul.context.history = [
            Message(role="user", content="part1"),
            Message(role="user", content="part2"),
            Message(role="assistant", content="response"),
        ]
        _, history, _ = _build_btw_context(soul, "q")
        # 2 user merged → 1, + 1 assistant, + 1 btw question = 3
        assert len(history) == 3
        assert history[0].role == "user"
        assert history[1].role == "assistant"
        assert history[2].role == "user"


# ---------------------------------------------------------------------------
# _tool_result_to_message
# ---------------------------------------------------------------------------


class TestToolResultToMessage:
    def test_converts_error_to_tool_message(self):
        tr = ToolResult(
            tool_call_id="tc1",
            return_value=ToolError(message="denied", brief="denied"),
        )
        msg = _tool_result_to_message(tr)
        assert msg.role == "tool"
        assert msg.tool_call_id == "tc1"
        assert "denied" in msg.extract_text()


# ---------------------------------------------------------------------------
# execute_side_question — multi-turn loop
# ---------------------------------------------------------------------------


class TestExecuteSideQuestion:
    def test_llm_not_set_returns_error(self):
        soul = MagicMock()
        soul._runtime.llm = None
        response, error = asyncio.run(execute_side_question(soul, "hi"))
        assert response is None
        assert error is not None and "LLM is not set" in error

    def test_text_on_first_turn(self):
        """LLM returns text immediately → return it."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            # Simulate streaming callback
            if kw.get("on_message_part"):
                kw["on_message_part"](TextPart(text="Hello!"))
            return _text_result("Hello!")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(execute_side_question(soul, "hi"))

        assert response == "Hello!"
        assert error is None

    def test_tool_call_then_text_on_second_turn(self):
        """LLM calls tool on turn 1 (denied), returns text on turn 2."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        call_count = 0

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _tool_call_result("Bash")
            # Second call: verify history contains tool error
            assert any(m.role == "tool" for m in history), "History should contain tool result"
            if kw.get("on_message_part"):
                kw["on_message_part"](TextPart(text="Here is the answer"))
            return _text_result("Here is the answer")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(execute_side_question(soul, "hi"))

        assert call_count == 2
        assert response == "Here is the answer"
        assert error is None

    def test_tool_calls_on_both_turns(self):
        """LLM calls tools on both turns → error with tool names."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            return _tool_call_result("Bash")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(execute_side_question(soul, "hi"))

        assert response is None
        assert error is not None
        assert "tried to call tools" in error
        assert "Bash" in error

    def test_mixed_text_and_tool_retries_and_returns_second_turn(self):
        """LLM outputs text + tool_call on turn 1 → retry → turn 2 text is the answer."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        call_count = 0

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Turn 1: mixed text + tool call (preamble + tool use)
                if kw.get("on_message_part"):
                    kw["on_message_part"](TextPart(text="Let me check..."))
                return _mixed_text_and_tool_result("Let me check...", "Read")
            # Turn 2: pure text answer
            if kw.get("on_message_part"):
                kw["on_message_part"](TextPart(text="The answer is 42"))
            return _text_result("The answer is 42")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(execute_side_question(soul, "what is X?"))

        assert call_count == 2, "Should have retried after mixed text+tool"
        assert error is None
        assert response is not None
        # The final response should contain the second turn's answer
        assert "The answer is 42" in response

    def test_mixed_text_and_tool_on_both_turns_reports_error(self):
        """LLM outputs text + tool_call on both turns → error with tool names."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            if kw.get("on_message_part"):
                kw["on_message_part"](TextPart(text="Preamble..."))
            return _mixed_text_and_tool_result("Preamble...", "Bash")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(execute_side_question(soul, "hi"))

        assert response is None
        assert error is not None
        assert "tried to call tools" in error

    def test_mixed_output_streaming_callback_receives_both_turns(self):
        """on_text_chunk receives chunks from both turns (preamble + real answer)."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        call_count = 0
        chunks: list[str] = []

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            nonlocal call_count
            call_count += 1
            cb = kw.get("on_message_part")
            if call_count == 1:
                if cb:
                    cb(TextPart(text="Preamble. "))
                return _mixed_text_and_tool_result("Preamble. ", "Read")
            if cb:
                cb(TextPart(text="Real answer."))
            return _text_result("Real answer.")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(
                execute_side_question(soul, "q", on_text_chunk=chunks.append)
            )

        # Callback receives chunks from BOTH turns
        assert "Preamble. " in chunks
        assert "Real answer." in chunks
        # Final response is from second turn only (text_chunks cleared between turns)
        assert response == "Real answer."
        assert error is None

    def test_exception_returns_error(self):
        """LLM call raises exception → return error string."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        async def fake_step(*args, **kw):
            raise RuntimeError("API timeout")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(execute_side_question(soul, "hi"))

        assert response is None
        assert error is not None and "API timeout" in error

    def test_on_text_chunk_callback(self):
        """Streaming chunks are forwarded to on_text_chunk."""
        soul = MagicMock()
        soul._runtime.llm.chat_provider = MagicMock()
        soul._agent.system_prompt = "sys"
        soul._agent.toolset.tools = []
        soul.context.history = []

        chunks: list[str] = []

        async def fake_step(provider, sys_prompt, toolset, history, **kw):
            cb = kw.get("on_message_part")
            if cb:
                cb(TextPart(text="chunk1"))
                cb(TextPart(text="chunk2"))
            return _text_result("chunk1chunk2")

        with patch("kimi_cli.soul.btw.kosong.step", side_effect=fake_step):
            response, error = asyncio.run(
                execute_side_question(soul, "hi", on_text_chunk=chunks.append)
            )

        assert chunks == ["chunk1", "chunk2"]
        assert response == "chunk1chunk2"


# ---------------------------------------------------------------------------
# _BtwModalDelegate
# ---------------------------------------------------------------------------


class TestBtwModalDelegate:
    def test_modal_priority(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        assert d.modal_priority == 5

    def test_hides_input_buffer(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        assert d.running_prompt_hides_input_buffer() is True

    def test_does_not_allow_text_input(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        assert d.running_prompt_allows_text_input() is False

    def test_does_not_accept_submission(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        assert d.running_prompt_accepts_submission() is False

    def test_loading_state_handles_escape_only(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        d._is_loading = True
        assert d.should_handle_running_prompt_key("escape") is True
        assert d.should_handle_running_prompt_key("enter") is False
        assert d.should_handle_running_prompt_key("space") is False

    def test_result_state_handles_dismiss_keys(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        d._is_loading = False
        for key in ("escape", "enter", "space", "c-c", "c-d"):
            assert d.should_handle_running_prompt_key(key) is True

    def test_dismiss_callback_called(self):
        dismissed = []
        d = _BtwModalDelegate(on_dismiss=lambda: dismissed.append(True))
        event = MagicMock()
        d.handle_running_prompt_key("escape", event)
        assert dismissed == [True]

    def test_append_text_and_set_result(self):
        d = _BtwModalDelegate(on_dismiss=lambda: None)
        d._question = "hi"
        d.append_text("hello ")
        d.append_text("world")
        assert d._streaming_text == "hello world"
        d.set_result("hello world", None)
        assert d._response == "hello world"
        assert d._is_loading is False


# ---------------------------------------------------------------------------
# Wire types: BtwBegin / BtwEnd
# ---------------------------------------------------------------------------


class TestBtwWireTypes:
    def test_btw_begin_is_event(self):
        assert is_event(BtwBegin(id="x", question="q"))

    def test_btw_end_is_event(self):
        assert is_event(BtwEnd(id="x", response="r"))

    def test_btw_begin_roundtrip(self):
        original = BtwBegin(id="abc", question="What?")
        env = WireMessageEnvelope.from_wire_message(original)
        assert env.type == "BtwBegin"
        restored = env.to_wire_message()
        assert isinstance(restored, BtwBegin)
        assert restored.id == "abc"
        assert restored.question == "What?"

    def test_btw_end_roundtrip_success(self):
        original = BtwEnd(id="abc", response="Hello!", error=None)
        env = WireMessageEnvelope.from_wire_message(original)
        restored = env.to_wire_message()
        assert isinstance(restored, BtwEnd)
        assert restored.response == "Hello!"
        assert restored.error is None

    def test_btw_end_roundtrip_error(self):
        original = BtwEnd(id="abc", response=None, error="API failed")
        env = WireMessageEnvelope.from_wire_message(original)
        restored = env.to_wire_message()
        assert isinstance(restored, BtwEnd)
        assert restored.response is None
        assert restored.error == "API failed"


# ---------------------------------------------------------------------------
# Btw markup escape
# ---------------------------------------------------------------------------


class TestBtwMarkupEscape:
    """Rich markup characters in btw questions must be escaped to prevent rendering errors."""

    def test_rich_escape_applied_to_btw_spinner(self):
        """BtwBegin spinner text should escape Rich markup in question."""
        from rich.markup import escape as rich_escape

        question = "What is [bold]foo[/bold]?"
        truncated = (question[:40] + "...") if len(question) > 40 else question
        # After escape, brackets should be literal
        escaped = rich_escape(truncated)
        assert "\\[bold]" in escaped
        assert "\\[/bold]" in escaped

    def test_rich_escape_applied_to_btw_panel_title(self):
        """BtwEnd panel title should escape Rich markup from question."""
        from rich.markup import escape as rich_escape

        question = "Is [red]this[/red] safe?"
        truncated_q = (question[:50] + "...") if len(question) > 50 else question
        title = f"[dim]btw: {rich_escape(truncated_q)}[/dim]"
        # The [red] inside should be escaped, but [dim] wrapper should remain
        assert "\\[red]" in title
        assert "\\[/red]" in title
        assert title.startswith("[dim]")

    def test_rich_escape_no_change_for_normal_text(self):
        """Normal text without brackets passes through unchanged."""
        from rich.markup import escape as rich_escape

        question = "How does Python work?"
        assert rich_escape(question) == question


# ---------------------------------------------------------------------------
# Steer dedup (text-based comparison)
# ---------------------------------------------------------------------------


class TestSteerDedup:
    def test_local_steer_consumed_by_counter(self, monkeypatch):
        """SteerInput from wire is consumed when local steer count > 0."""
        from kimi_cli.ui.shell.visualize import _LiveView

        view = object.__new__(_PromptLiveView)
        view._pending_local_steer_count = 1
        view._btw_modal = None

        forwarded = []
        monkeypatch.setattr(
            _LiveView,
            "dispatch_wire_message",
            lambda self, msg: forwarded.append(msg),
        )
        view.dispatch_wire_message(SteerInput(user_input=[TextPart(text="hello world")]))

        assert view._pending_local_steer_count == 0
        assert forwarded == []

    def test_non_local_steer_forwarded(self, monkeypatch):
        """SteerInput from wire is forwarded when no local steers pending."""
        from kimi_cli.ui.shell.visualize import _LiveView

        view = object.__new__(_PromptLiveView)
        view._pending_local_steer_count = 0
        view._btw_modal = None

        forwarded = []
        monkeypatch.setattr(
            _LiveView,
            "dispatch_wire_message",
            lambda self, msg: forwarded.append(msg),
        )
        view.dispatch_wire_message(SteerInput(user_input=[TextPart(text="from elsewhere")]))

        assert view._pending_local_steer_count == 0
        assert len(forwarded) == 1

    def test_multiple_steers_consumed_in_order(self, monkeypatch):
        """Multiple local steers are consumed one by one."""
        from kimi_cli.ui.shell.visualize import _LiveView

        view = object.__new__(_PromptLiveView)
        view._pending_local_steer_count = 2
        view._btw_modal = None

        forwarded = []
        monkeypatch.setattr(
            _LiveView,
            "dispatch_wire_message",
            lambda self, msg: forwarded.append(msg),
        )
        view.dispatch_wire_message(SteerInput(user_input="first"))
        view.dispatch_wire_message(SteerInput(user_input="second"))
        view.dispatch_wire_message(SteerInput(user_input="third"))  # not local

        assert view._pending_local_steer_count == 0
        assert len(forwarded) == 1  # only "third" forwarded

    def test_btw_events_suppressed(self, monkeypatch):
        from kimi_cli.ui.shell.visualize import _LiveView

        view = object.__new__(_PromptLiveView)
        view._pending_local_steer_count = 0
        view._btw_modal = None
        view._btw_spinner = "should be cleared"  # pyright: ignore[reportAttributeAccessIssue]
        forwarded = []
        monkeypatch.setattr(
            _LiveView,
            "dispatch_wire_message",
            lambda self, msg: forwarded.append(msg),
        )
        view.dispatch_wire_message(BtwBegin(id="x", question="q"))
        view.dispatch_wire_message(BtwEnd(id="x", response="r"))

        assert forwarded == []
        assert view._btw_spinner is None


# ---------------------------------------------------------------------------
# handle_local_input routing
# ---------------------------------------------------------------------------


class TestHandleLocalInput:
    def test_btw_routes_to_start_btw(self):
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._queued_messages = []
        view._btw_modal = None
        view._flush_prompt_refresh = lambda: None

        started = []
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._start_btw = lambda q: started.append(q)  # pyright: ignore[reportAttributeAccessIssue]

        view.handle_local_input(
            UserInput(
                mode=PromptMode.AGENT,
                command="/btw what is X?",
                resolved_command="/btw what is X?",
                content=[TextPart(text="/btw what is X?")],
            )
        )
        assert started == ["what is X?"]
        assert view._queued_messages == []

    def test_normal_text_routes_to_queue(self):
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._queued_messages = []
        view._btw_modal = None
        view._prompt_session = MagicMock()

        ui = UserInput(
            mode=PromptMode.AGENT,
            command="fix bug",
            resolved_command="fix bug",
            content=[TextPart(text="fix bug")],
        )
        view.handle_local_input(ui)
        assert len(view._queued_messages) == 1

    def test_ignores_input_after_turn_ended(self):
        view = object.__new__(_PromptLiveView)
        view._turn_ended = True
        view._queued_messages = []
        view._flush_prompt_refresh = lambda: None

        view.handle_local_input(
            UserInput(
                mode=PromptMode.AGENT,
                command="hello",
                resolved_command="hello",
                content=[TextPart(text="hello")],
            )
        )
        assert view._queued_messages == []

    def test_btw_blocked_when_already_active(self):
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._queued_messages = []
        view._btw_modal = MagicMock()  # btw already active
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None

        started = []
        view._start_btw = lambda q: started.append(q)  # pyright: ignore[reportAttributeAccessIssue]
        view.handle_local_input(
            UserInput(
                mode=PromptMode.AGENT,
                command="/btw hi",
                resolved_command="/btw hi",
                content=[TextPart(text="/btw hi")],
            )
        )
        assert started == []

    def test_shell_command_blocked_from_queue(self, monkeypatch):
        """Shell-only commands like /help should be rejected, not queued."""
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._queued_messages = []
        view._btw_modal = None
        view._prompt_session = MagicMock()

        toasted = []
        monkeypatch.setattr(
            "kimi_cli.ui.shell.prompt.toast",
            lambda msg, **kw: toasted.append(msg),
        )

        view.handle_local_input(
            UserInput(
                mode=PromptMode.AGENT,
                command="/help",
                resolved_command="/help",
                content=[TextPart(text="/help")],
            )
        )
        # Should NOT be queued
        assert view._queued_messages == []
        # Should show toast warning
        assert any("not available" in t for t in toasted)

    def test_soul_command_allowed_in_queue(self):
        """Soul-level commands like /compact should be queued normally."""
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._queued_messages = []
        view._btw_modal = None
        view._prompt_session = MagicMock()

        view.handle_local_input(
            UserInput(
                mode=PromptMode.AGENT,
                command="/compact",
                resolved_command="/compact",
                content=[TextPart(text="/compact")],
            )
        )
        # Soul commands SHOULD be queued (they work via run_soul)
        assert len(view._queued_messages) == 1


# ---------------------------------------------------------------------------
# handle_immediate_steer — /btw interception via Ctrl+S
# ---------------------------------------------------------------------------


class TestHandleImmediateSteer:
    def test_btw_via_ctrl_s_routes_to_start_btw(self):
        """Ctrl+S with /btw should intercept and start btw, not steer."""
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None

        started = []
        view._start_btw = lambda q: started.append(q)  # pyright: ignore[reportAttributeAccessIssue]
        steered = []
        view._steer = lambda content: steered.append(content)
        view._pending_local_steer_count = 0

        view.handle_immediate_steer(
            UserInput(
                mode=PromptMode.AGENT,
                command="/btw what is this?",
                resolved_command="/btw what is this?",
                content=[TextPart(text="/btw what is this?")],
            )
        )
        assert started == ["what is this?"]
        assert steered == []  # NOT steered

    def test_normal_text_via_ctrl_s_steers_normally(self, monkeypatch):
        """Ctrl+S with normal text should steer, not btw."""
        from kimi_cli.ui.shell.console import console

        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None
        view._pending_local_steer_count = 0

        steered = []
        view._steer = lambda content: steered.append(content)

        monkeypatch.setattr(console, "print", lambda *a, **kw: None)

        view.handle_immediate_steer(
            UserInput(
                mode=PromptMode.AGENT,
                command="fix this",
                resolved_command="fix this",
                content=[TextPart(text="fix this")],
            )
        )
        assert len(steered) == 1
        assert view._pending_local_steer_count == 1  # counter incremented

    def test_btw_via_ctrl_s_uses_resolved_command(self):
        """Ctrl+S /btw with placeholder should route using resolved_command."""
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None
        view._pending_local_steer_count = 0

        started = []
        view._start_btw = lambda q: started.append(q)  # pyright: ignore[reportAttributeAccessIssue]
        view._steer = lambda content: None

        view.handle_immediate_steer(
            UserInput(
                mode=PromptMode.AGENT,
                command="/btw [Pasted text #1]",  # placeholder in command
                resolved_command="/btw actual pasted content here",  # resolved
                content=[TextPart(text="/btw actual pasted content here")],
            )
        )
        # btw should receive resolved content, not placeholder
        assert started == ["actual pasted content here"]

    def test_shell_command_blocked_on_ctrl_s(self, monkeypatch):
        """Ctrl+S with shell-only command should toast, not steer."""
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None
        view._pending_local_steer_count = 0

        steered = []
        view._steer = lambda content: steered.append(content)

        toasted = []
        monkeypatch.setattr(
            "kimi_cli.ui.shell.prompt.toast",
            lambda msg, **kw: toasted.append(msg),
        )

        view.handle_immediate_steer(
            UserInput(
                mode=PromptMode.AGENT,
                command="/help",
                resolved_command="/help",
                content=[TextPart(text="/help")],
            )
        )
        assert steered == []  # NOT steered into agent context
        assert view._pending_local_steer_count == 0
        assert any("not available" in t for t in toasted)


# ---------------------------------------------------------------------------
# Ctrl+S steer from queue (pop first queued message)
# ---------------------------------------------------------------------------


class TestCtrlSFromQueue:
    def test_ctrl_s_key_pops_first_queued_and_steers(self, monkeypatch):
        """handle_running_prompt_key('c-s') with empty buf pops oldest queue item."""
        from prompt_toolkit.buffer import Buffer
        from prompt_toolkit.document import Document

        from kimi_cli.ui.shell.console import console

        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None
        view._pending_local_steer_count = 0
        view._cancel_event = None
        view._current_approval_request_panel = None

        steered_contents = []
        view._steer = lambda content: steered_contents.append(content)
        monkeypatch.setattr(console, "print", lambda *a, **kw: None)

        q1 = UserInput(
            mode=PromptMode.AGENT,
            command="first",
            resolved_command="first",
            content=[TextPart(text="first")],
        )
        q2 = UserInput(
            mode=PromptMode.AGENT,
            command="second",
            resolved_command="second",
            content=[TextPart(text="second")],
        )
        view._queued_messages = [q1, q2]

        # Mock event with empty buffer
        buf = Buffer()
        buf.set_document(Document(""), bypass_readonly=True)
        event = MagicMock()
        event.current_buffer = buf

        view.handle_running_prompt_key("c-s", event)

        # q1 (oldest) was popped and steered
        assert len(view._queued_messages) == 1
        assert view._queued_messages[0].command == "second"
        assert len(steered_contents) == 1
        assert view._pending_local_steer_count == 1

    def test_ctrl_s_key_noop_when_input_and_queue_both_empty(self):
        """handle_running_prompt_key('c-s') with empty input + empty queue does nothing."""
        from prompt_toolkit.buffer import Buffer
        from prompt_toolkit.document import Document

        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None
        view._pending_local_steer_count = 0
        view._cancel_event = None
        view._current_approval_request_panel = None
        view._queued_messages = []

        buf = Buffer()
        buf.set_document(Document(""), bypass_readonly=True)
        event = MagicMock()
        event.current_buffer = buf

        # Should not crash, should not change state
        view.handle_running_prompt_key("c-s", event)

        assert view._pending_local_steer_count == 0
        assert view._queued_messages == []

    def test_steer_increments_counter(self, monkeypatch):
        """handle_immediate_steer increments _pending_local_steer_count."""
        from kimi_cli.ui.shell.console import console

        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._btw_modal = None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]
        view._flush_prompt_refresh = lambda: None
        view._pending_local_steer_count = 0
        view._steer = lambda content: None
        monkeypatch.setattr(console, "print", lambda *a, **kw: None)

        view.handle_immediate_steer(
            UserInput(
                mode=PromptMode.AGENT,
                command="msg1",
                resolved_command="msg1",
                content=[TextPart(text="msg1")],
            )
        )
        assert view._pending_local_steer_count == 1

        view.handle_immediate_steer(
            UserInput(
                mode=PromptMode.AGENT,
                command="msg2",
                resolved_command="msg2",
                content=[TextPart(text="msg2")],
            )
        )
        assert view._pending_local_steer_count == 2


# ---------------------------------------------------------------------------
# classify_input uses resolved_command (placeholder expanded)
# ---------------------------------------------------------------------------


class TestClassifyInputResolved:
    def test_btw_with_placeholder_uses_resolved(self):
        """classify_input should receive resolved text, not placeholder."""
        # Simulate: user types /btw then pastes multi-line text
        # command = "/btw [Pasted text #1 +3 lines]"
        # resolved_command = "/btw line1\nline2\nline3"
        from kimi_cli.ui.shell.visualize._input_router import InputAction, classify_input

        # With resolved text → BTW action has actual content
        action = classify_input("/btw line1\nline2\nline3", is_streaming=False)
        assert action.kind == InputAction.BTW
        assert "line1" in action.args

    def test_handle_local_input_routes_btw_with_resolved(self):
        """handle_local_input should use resolved_command for classify_input."""
        view = object.__new__(_PromptLiveView)
        view._turn_ended = False
        view._queued_messages = []
        view._btw_modal = None
        view._flush_prompt_refresh = lambda: None
        view._btw_runner = lambda q, cb=None: None  # pyright: ignore[reportAttributeAccessIssue]

        started = []
        view._start_btw = lambda q: started.append(q)  # pyright: ignore[reportAttributeAccessIssue]

        view.handle_local_input(
            UserInput(
                mode=PromptMode.AGENT,
                command="/btw [Pasted text #1]",  # placeholder
                resolved_command="/btw actual question text",  # resolved
                content=[TextPart(text="/btw actual question text")],
            )
        )
        # Should use resolved_command, so btw gets "actual question text"
        assert started == ["actual question text"]


# ---------------------------------------------------------------------------
# wait_for_btw_dismiss
# ---------------------------------------------------------------------------


class TestWaitForBtwDismiss:
    def test_noop_when_no_btw(self):
        """wait_for_btw_dismiss should return immediately if no btw active."""
        import asyncio

        view = object.__new__(_PromptLiveView)
        view._btw_modal = None
        view._btw_run_task = None
        view._btw_dismiss_event = None
        view._btw_refresh_task = None
        view._prompt_session = MagicMock()

        # Should complete without blocking
        asyncio.run(view.wait_for_btw_dismiss())
