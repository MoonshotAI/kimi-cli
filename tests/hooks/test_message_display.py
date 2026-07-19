"""Tests for the MessageDisplay hook: pure debounce logic and the dispatcher."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kimi_cli.hooks.message_display import (
    MESSAGE_DISPLAY_DEBOUNCE_MS,
    MessageDisplayDispatcher,
    initial_message_display_state,
    step_message_display,
)

DEBOUNCE = MESSAGE_DISPLAY_DEBOUNCE_MS / 1000


# --- step_message_display (pure, no IO) ---


def test_initial_state_is_empty() -> None:
    state = initial_message_display_state(now=10.0)
    assert state.displayed_text == ""
    assert state.last_flush == 10.0
    assert state.last_flushed_text == ""


def test_no_flush_inside_debounce_window() -> None:
    state = initial_message_display_state(now=0.0)
    state, flush = step_message_display(state, "hello", now=0.1, debounce=DEBOUNCE, is_final=False)
    assert flush is None
    assert state.displayed_text == "hello"


def test_flush_once_window_elapsed_with_new_text() -> None:
    state = initial_message_display_state(now=0.0)
    state, flush = step_message_display(
        state, "hello", now=DEBOUNCE, debounce=DEBOUNCE, is_final=False
    )
    assert flush is not None
    assert flush.displayed_text == "hello"
    assert flush.is_final is False
    assert state.last_flushed_text == "hello"
    assert state.last_flush == DEBOUNCE


def test_accumulates_across_non_flushing_steps() -> None:
    state = initial_message_display_state(now=0.0)
    state, _ = step_message_display(state, "hel", now=0.05, debounce=DEBOUNCE, is_final=False)
    state, flush = step_message_display(state, "lo", now=0.25, debounce=DEBOUNCE, is_final=False)
    assert flush is not None
    assert flush.displayed_text == "hello"


def test_no_flush_when_due_by_time_but_no_new_text() -> None:
    state = initial_message_display_state(now=0.0)
    state, flush = step_message_display(state, "hello", now=1.0, debounce=DEBOUNCE, is_final=False)
    assert flush is not None
    state, flush = step_message_display(state, "", now=2.0, debounce=DEBOUNCE, is_final=False)
    assert flush is None


def test_final_flush_is_unconditional_inside_window() -> None:
    state = initial_message_display_state(now=0.0)
    state, _ = step_message_display(state, "hello", now=0.05, debounce=DEBOUNCE, is_final=False)
    state, flush = step_message_display(state, "", now=0.1, debounce=DEBOUNCE, is_final=True)
    assert flush is not None
    assert flush.is_final is True
    assert flush.displayed_text == "hello"


def test_final_flush_carries_full_cumulative_text() -> None:
    state = initial_message_display_state(now=0.0)
    state, flushed = step_message_display(state, "hel", now=0.3, debounce=DEBOUNCE, is_final=False)
    assert flushed is not None
    state, _ = step_message_display(state, "lo", now=0.35, debounce=DEBOUNCE, is_final=False)
    state, flush = step_message_display(state, "!", now=0.4, debounce=DEBOUNCE, is_final=True)
    assert flush is not None
    assert flush.displayed_text == "hello!"


def test_debounce_clock_resets_per_flush() -> None:
    state = initial_message_display_state(now=0.0)
    state, flush = step_message_display(state, "a", now=0.2, debounce=DEBOUNCE, is_final=False)
    assert flush is not None
    # 0.19s after the flush: inside the new window
    state, flush = step_message_display(state, "b", now=0.39, debounce=DEBOUNCE, is_final=False)
    assert flush is None
    assert state.displayed_text == "ab"


# --- MessageDisplayDispatcher ---


class _FakeEngine:
    """Controllable stand-in for HookEngine.fire_and_forget_trigger."""

    def __init__(self, *, auto_complete: bool = True, fail: bool = False) -> None:
        self.payloads: list[dict[str, Any]] = []
        self.gates: list[asyncio.Event] = []
        self._auto_complete = auto_complete
        self._fail = fail

    def fire_and_forget_trigger(
        self, event: str, *, matcher_value: str = "", input_data: dict[str, Any]
    ) -> asyncio.Task[list[Any]]:
        assert event == "MessageDisplay"
        self.payloads.append(input_data)
        gate = asyncio.Event()
        self.gates.append(gate)

        async def _deliver() -> list[Any]:
            if not self._auto_complete:
                await gate.wait()
            if self._fail:
                raise RuntimeError("delivery failed")
            return []

        task = asyncio.create_task(_deliver())
        if self._fail:
            task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
        return task


def _make_dispatcher(
    engine: _FakeEngine, now: list[float], **kwargs: Any
) -> MessageDisplayDispatcher:
    return MessageDisplayDispatcher(
        engine,  # type: ignore[arg-type]
        session_id="session-1",
        cwd="/work",
        clock=lambda: now[0],
        **kwargs,
    )


async def _settle() -> None:
    # Let completed tasks run their done callbacks (delivery -> pump).
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_mid_stream_and_final_share_message_id() -> None:
    engine = _FakeEngine()
    now = [0.0]
    d = _make_dispatcher(engine, now)
    d.add_chunk("hello")  # inside window: no flush
    now[0] = 1.0
    d.add_chunk(" world")  # window elapsed: mid-stream flush
    await d.finish()
    assert len(engine.payloads) == 2
    mid, final = engine.payloads
    assert mid["is_final"] is False
    assert mid["displayed_text"] == "hello world"
    assert final["is_final"] is True
    assert final["displayed_text"] == "hello world"
    assert mid["message_id"] == final["message_id"] == d.message_id
    assert final["session_id"] == "session-1"
    assert final["cwd"] == "/work"
    assert final["hook_event_name"] == "MessageDisplay"


@pytest.mark.asyncio
async def test_fast_stream_fires_only_final() -> None:
    engine = _FakeEngine()
    now = [0.0]
    d = _make_dispatcher(engine, now)
    d.add_chunk("Hello")
    d.add_chunk(" world")
    await d.finish()
    assert len(engine.payloads) == 1
    assert engine.payloads[0]["is_final"] is True
    assert engine.payloads[0]["displayed_text"] == "Hello world"


@pytest.mark.asyncio
async def test_slow_hook_coalesces_to_newest_pending() -> None:
    engine = _FakeEngine(auto_complete=False)
    now = [0.0]
    d = _make_dispatcher(engine, now)
    now[0] = 1.0
    d.add_chunk("a")  # in-flight delivery #1
    now[0] = 2.0
    d.add_chunk("b")  # queued as pending
    now[0] = 3.0
    d.add_chunk("c")  # replaces pending: newest cumulative text wins
    assert len(engine.payloads) == 1
    engine.gates[0].set()
    await _settle()
    assert len(engine.payloads) == 2
    assert engine.payloads[1]["displayed_text"] == "abc"
    assert engine.payloads[1]["is_final"] is False
    engine.gates[1].set()
    await d.finish()
    assert len(engine.payloads) == 3
    assert engine.payloads[2]["is_final"] is True
    assert engine.payloads[2]["displayed_text"] == "abc"


@pytest.mark.asyncio
async def test_final_dispatches_alongside_stale_in_flight() -> None:
    engine = _FakeEngine(auto_complete=False)
    now = [0.0]
    d = _make_dispatcher(engine, now)
    now[0] = 1.0
    d.add_chunk("a")  # in-flight delivery #1
    now[0] = 2.0
    d.add_chunk("b")  # queued as pending
    finish_task = asyncio.create_task(d.finish())
    await _settle()
    # The final payload never queues behind the stale delivery.
    assert len(engine.payloads) == 2
    assert engine.payloads[1]["displayed_text"] == "ab"
    assert engine.payloads[1]["is_final"] is True
    assert not finish_task.done()  # still waiting on the final delivery
    engine.gates[1].set()
    await asyncio.wait_for(finish_task, timeout=1)
    engine.gates[0].set()  # stale delivery settles late: no extra dispatch
    await _settle()
    assert len(engine.payloads) == 2


@pytest.mark.asyncio
async def test_finish_is_idempotent() -> None:
    engine = _FakeEngine()
    now = [0.0]
    d = _make_dispatcher(engine, now)
    d.add_chunk("hello")
    await asyncio.gather(d.finish(), d.finish())
    await d.finish()
    finals = [p for p in engine.payloads if p["is_final"]]
    assert len(finals) == 1


@pytest.mark.asyncio
async def test_no_text_streamed_fires_nothing() -> None:
    engine = _FakeEngine()
    now = [0.0]
    d = _make_dispatcher(engine, now)
    await d.finish()
    assert engine.payloads == []


@pytest.mark.asyncio
async def test_abort_suppresses_final_and_skips_wait() -> None:
    engine = _FakeEngine(auto_complete=False)
    now = [0.0]
    d = _make_dispatcher(engine, now)
    now[0] = 1.0
    d.add_chunk("partial")  # in-flight mid-stream delivery
    d.abort()
    await asyncio.wait_for(d.finish(), timeout=1)  # returns without waiting
    assert len(engine.payloads) == 1
    assert engine.payloads[0]["is_final"] is False
    engine.gates[0].set()


@pytest.mark.asyncio
async def test_chunks_after_abort_still_flush_mid_stream() -> None:
    engine = _FakeEngine()
    now = [0.0]
    d = _make_dispatcher(engine, now)
    d.abort()
    now[0] = 1.0
    d.add_chunk("text")
    assert len(engine.payloads) == 1
    assert engine.payloads[0]["is_final"] is False
    await d.finish()
    assert len(engine.payloads) == 1


@pytest.mark.asyncio
async def test_chunks_after_finish_are_ignored() -> None:
    engine = _FakeEngine()
    now = [0.0]
    d = _make_dispatcher(engine, now)
    d.add_chunk("hello")
    await d.finish()
    now[0] = 10.0
    d.add_chunk("late")
    assert len(engine.payloads) == 1


@pytest.mark.asyncio
async def test_failed_final_delivery_does_not_raise() -> None:
    engine = _FakeEngine(fail=True)
    now = [0.0]
    d = _make_dispatcher(engine, now)
    d.add_chunk("hello")
    await d.finish()  # failure is logged by the engine, swallowed here
    assert engine.payloads[0]["is_final"] is True


@pytest.mark.asyncio
async def test_drain_timeout_leaves_delivery_running() -> None:
    engine = _FakeEngine(auto_complete=False)
    now = [0.0]
    d = _make_dispatcher(engine, now, drain_timeout=0.05)
    d.add_chunk("hello")
    await d.finish()  # returns after ~50ms although the delivery is still pending
    assert engine.payloads[0]["is_final"] is True
    engine.gates[0].set()  # the delivery is not cancelled and can still complete
    await _settle()
