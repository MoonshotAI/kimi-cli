"""MessageDisplay hook: fires repeatedly as the assistant reply streams.

``Stop`` fires once at the end of the turn; ``MessageDisplay`` fires per
streamed message (one model call), debounced, with the cumulative displayed
text — useful for live narration, incremental logging, or any consumer that
wants to react to the reply as it is written rather than after the fact.

The debounce decision lives in :func:`step_message_display`, pure (no IO, no
real timer), so tests can drive it directly. :class:`MessageDisplayDispatcher`
owns delivery against the hook engine:

- at most one mid-stream delivery in flight per message; while one runs,
  newer debounced payloads replace the queued one rather than piling up
  (lossless — every payload carries the full cumulative text);
- the final payload (``is_final: true``) is dispatched immediately, alongside
  any still-running mid-stream delivery, and always carries the full text;
- the turn waits for the final delivery to complete, bounded by a shared
  drain budget, so a headless run does not exit with the tail undelivered.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from kimi_cli import logger
from kimi_cli.hooks import events
from kimi_cli.hooks.engine import HookEngine
from kimi_cli.hooks.runner import HookResult

# Debounce window: bounds how often a hook process gets spawned per streamed reply.
MESSAGE_DISPLAY_DEBOUNCE_MS = 200

# Ceiling on the teardown wait for the final payload's delivery.
MESSAGE_DISPLAY_DRAIN_TIMEOUT_S = 5.0


@dataclass(frozen=True)
class MessageDisplayState:
    """Debounce accumulator for one streamed message."""

    displayed_text: str
    """Cumulative text streamed so far (all chunks appended in order)."""
    last_flush: float
    """Clock value of the last flush, or the state's creation time if none yet."""
    last_flushed_text: str
    """``displayed_text`` as of the last flush, to detect "nothing new to say"."""


@dataclass(frozen=True)
class MessageDisplayFlush:
    """What a flush delivers: the full cumulative text, plus finality."""

    displayed_text: str
    is_final: bool


def initial_message_display_state(now: float) -> MessageDisplayState:
    return MessageDisplayState(displayed_text="", last_flush=now, last_flushed_text="")


def step_message_display(
    prev: MessageDisplayState,
    chunk: str,
    now: float,
    debounce: float,
    is_final: bool,
) -> tuple[MessageDisplayState, MessageDisplayFlush | None]:
    """Decide what one streamed chunk does to the accumulator, purely (no IO).

    A flush fires when either:

    - ``is_final`` is true (the caller is closing out this message — always
      flushes, even with an empty chunk, so the reply's tail is never dropped
      waiting on the debounce window), or
    - there is new text since the last flush AND at least ``debounce`` seconds
      have elapsed since then.

    Otherwise the chunk is folded into ``displayed_text`` with no flush — the
    caller fires nothing for this chunk.
    """
    displayed_text = prev.displayed_text + chunk
    has_new_text = displayed_text != prev.last_flushed_text
    due_by_time = now - prev.last_flush >= debounce
    if not (is_final or (has_new_text and due_by_time)):
        return (
            MessageDisplayState(displayed_text, prev.last_flush, prev.last_flushed_text),
            None,
        )
    return (
        MessageDisplayState(displayed_text, now, displayed_text),
        MessageDisplayFlush(displayed_text, is_final),
    )


class MessageDisplayDispatcher:
    """Delivers MessageDisplay hook payloads for one streamed message.

    One dispatcher per message (one model call): mints the ``message_id`` and
    owns the debounce accumulator. ``add_chunk`` is called synchronously from
    the streaming callback; ``finish`` is awaited when the message ends, on
    every exit path; ``abort`` marks the message abandoned (cancellation) so
    no ``is_final`` fires.
    """

    def __init__(
        self,
        engine: HookEngine,
        *,
        session_id: str,
        cwd: str,
        debounce_ms: int = MESSAGE_DISPLAY_DEBOUNCE_MS,
        drain_timeout: float = MESSAGE_DISPLAY_DRAIN_TIMEOUT_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._engine = engine
        self._session_id = session_id
        self._cwd = cwd
        self._debounce = debounce_ms / 1000
        self._drain_timeout = drain_timeout
        self._clock = clock
        self.message_id = uuid.uuid4().hex
        self._state = initial_message_display_state(clock())
        self._in_flight: asyncio.Task[list[HookResult]] | None = None
        self._pending: str | None = None
        self._final_task: asyncio.Task[list[HookResult]] | None = None
        self._drain_deadline: float | None = None
        self._finished = False
        self._aborted = False

    def add_chunk(self, chunk: str) -> None:
        """Fold one streamed text chunk into the accumulator; flush if due.

        Chunks arriving after ``finish`` are ignored. Chunks arriving after
        ``abort`` still flush mid-stream — only the final payload is
        suppressed on abort.
        """
        if self._finished:
            return
        self._state, flush = step_message_display(
            self._state, chunk, self._clock(), self._debounce, is_final=False
        )
        if flush is not None:
            self._dispatch_mid(flush.displayed_text)

    def abort(self) -> None:
        """Mark the message abandoned: no ``is_final`` payload, no drain wait."""
        self._aborted = True
        self._pending = None

    async def finish(self) -> None:
        """Close out the message: dispatch ``is_final`` and wait for it, bounded.

        Idempotent; concurrent callers share one drain budget. Skips the final
        payload when the message was aborted or produced no displayed text
        (tool-call-only). The final payload is dispatched immediately —
        alongside a still-running mid-stream delivery if there is one (the one
        exception to one-at-a-time, justified because the final cumulative
        text strictly supersedes whatever that delivery is processing).
        """
        if not self._finished:
            self._finished = True
            if not self._aborted and self._state.displayed_text:
                self._pending = None
                self._final_task = self._dispatch(self._state.displayed_text, is_final=True)
        await self._drain()

    def _dispatch(self, displayed_text: str, *, is_final: bool) -> asyncio.Task[list[HookResult]]:
        return self._engine.fire_and_forget_trigger(
            "MessageDisplay",
            input_data=events.message_display(
                session_id=self._session_id,
                cwd=self._cwd,
                message_id=self.message_id,
                displayed_text=displayed_text,
                is_final=is_final,
            ),
        )

    def _dispatch_mid(self, displayed_text: str) -> None:
        in_flight = self._in_flight
        if in_flight is not None and not in_flight.done():
            # One mid-stream delivery at a time; the newer cumulative text
            # replaces the queued one rather than piling up behind it. A hook
            # slower than the debounce window therefore skips intermediate
            # snapshots — lossless, since each payload is the full text.
            self._pending = displayed_text
            return
        self._start_mid(displayed_text)

    def _start_mid(self, displayed_text: str) -> None:
        task = self._dispatch(displayed_text, is_final=False)
        self._in_flight = task
        task.add_done_callback(self._pump)

    def _pump(self, _task: asyncio.Task[list[HookResult]]) -> None:
        if self._finished:
            # The final payload already supersedes anything still queued.
            self._pending = None
            return
        if self._pending is not None:
            pending, self._pending = self._pending, None
            self._start_mid(pending)

    async def _drain(self) -> None:
        """Wait for the final delivery to settle, within the shared budget."""
        task = self._final_task
        if task is None:
            return
        if self._drain_deadline is None:
            self._drain_deadline = self._clock() + self._drain_timeout
        remaining = self._drain_deadline - self._clock()
        if remaining <= 0:
            return
        try:
            # Shield so the delivery survives the wait being cancelled or
            # timing out; the hook process is left to finish on its own.
            await asyncio.wait_for(asyncio.shield(task), remaining)
        except TimeoutError:
            logger.warning(
                "MessageDisplay hook for message {} still running after {}s; "
                "continuing without waiting for it",
                self.message_id,
                self._drain_timeout,
            )
        except Exception:
            # Delivery failures are already logged by the engine's
            # fire-and-forget done callback; never let them break the turn.
            pass
