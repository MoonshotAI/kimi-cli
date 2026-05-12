from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from kimi_cli.loop.models import JitterConfig, LoopConfig, LoopTask
from kimi_cli.loop.store import LoopStore
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul


@dataclass
class _TaskState:
    """Runtime tracking for a scheduled task."""

    task: LoopTask
    next_fire_at: int  # epoch ms
    in_flight: bool = False


# ---------------------------------------------------------------------------
# Cron helpers
# ---------------------------------------------------------------------------


def _try_import_croniter():
    try:
        from croniter import croniter  # type: ignore[import-untyped]

        return croniter
    except ImportError:
        return None


def _frac_from_id(task_id: str) -> float:
    """Stable hash of task ID into [0, 1)."""
    digest = hashlib.sha256(task_id.encode()).hexdigest()
    return int(digest[:16], 16) / (2**64)


def _next_cron_run_ms(cron: str, from_ms: int) -> int | None:
    """Return the next cron fire time at or after *from_ms* (epoch ms)."""
    croniter = _try_import_croniter()
    if croniter is None:
        raise RuntimeError("croniter is required for cron scheduling but not installed")

    try:
        itr = croniter(cron, start_time=from_ms / 1000.0)
    except Exception as e:
        logger.warning("Invalid cron expression '{cron}': {error}", cron=cron, error=e)
        return None

    nxt = itr.get_next(float)
    if nxt is None:
        return None
    return int(nxt * 1000)


def _compute_next_fire_at(task: LoopTask, from_ms: int, cfg: JitterConfig) -> int | None:
    """Compute the jittered next fire time for a task."""
    t1 = _next_cron_run_ms(task.cron, from_ms)
    if t1 is None:
        return None

    if not task.recurring:
        # One-shot jitter: backward lead on round-minute boundaries
        t1_minute = int((t1 / 1000) // 60)
        if t1_minute % cfg.one_shot_minute_mod != 0:
            return t1
        frac = _frac_from_id(task.id)
        lead = cfg.one_shot_floor_ms + int(frac * (cfg.one_shot_max_ms - cfg.one_shot_floor_ms))
        return max(t1 - lead, from_ms)

    # Recurring jitter: forward delay proportional to interval
    t2 = _next_cron_run_ms(task.cron, t1)
    if t2 is None:
        return t1

    interval_ms = t2 - t1
    if interval_ms <= 0:
        return t1

    frac = _frac_from_id(task.id)
    jitter = min(int(frac * cfg.recurring_frac * interval_ms), cfg.recurring_cap_ms)
    return t1 + jitter


# ---------------------------------------------------------------------------
# Cross-session lock (PID-based)
# ---------------------------------------------------------------------------


class _LoopLock:
    """Simple PID-based file lock to prevent double-firing across sessions."""

    def __init__(self, lock_path: Path) -> None:
        self._lock_path = lock_path
        self._owned = False

    def acquire(self) -> bool:
        """Try to acquire the lock. Returns True if we now own it."""
        try:
            if self._lock_path.exists():
                try:
                    pid = int(self._lock_path.read_text(encoding="utf-8").strip())
                except (ValueError, OSError):
                    pid = None

                if pid is not None and pid != os.getpid() and self._pid_alive(pid):
                    return False
                # stale lock

            self._lock_path.write_text(str(os.getpid()), encoding="utf-8")
            self._owned = True
            return True
        except OSError:
            return False

    def release(self) -> None:
        if not self._owned:
            return
        try:
            if self._lock_path.exists():
                current = self._lock_path.read_text(encoding="utf-8").strip()
                if current == str(os.getpid()):
                    self._lock_path.unlink(missing_ok=True)
        except OSError:
            pass
        self._owned = False

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            if hasattr(os, "kill"):
                os.kill(pid, 0)
                return True
        except (OSError, ProcessLookupError):
            pass
        return False


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------


class LoopScheduler:
    """In-process asyncio scheduler for loop tasks."""

    def __init__(
        self,
        session_dir: Path | None = None,
        config: LoopConfig | None = None,
    ) -> None:
        self._store = LoopStore(session_dir)
        self._config = config or LoopConfig()
        self._task_states: dict[str, _TaskState] = {}
        self._soul: KimiSoul | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopped = True
        self._lock = _LoopLock(session_dir / ".loop.lock") if session_dir else None
        self._lock_owned = False
        self._last_lock_probe = 0.0
        self._lock_probe_interval_s = 5.0

    # ------------------------------------------------------------------
    # Soul binding
    # ------------------------------------------------------------------

    def bind_soul(self, soul: KimiSoul) -> None:
        self._soul = soul

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if not self._config.enabled:
            return
        if self._task is not None and not self._task.done():
            return

        self._stopped = False
        # Load durable tasks if we acquire the lock
        self._maybe_load_durable()
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("Loop scheduler started")

    def stop(self) -> None:
        self._stopped = True
        if self._task is not None and not self._task.done():
            self._task.cancel()
        if self._lock is not None and self._lock_owned:
            self._lock.release()
            self._lock_owned = False
        logger.info("Loop scheduler stopped")

    # ------------------------------------------------------------------
    # Task management
    # ------------------------------------------------------------------

    def add_task(self, task: LoopTask) -> None:
        if self._store.count() >= self._config.max_jobs:
            raise RuntimeError(
                f"Maximum number of scheduled tasks ({self._config.max_jobs}) reached"
            )

        now_ms = int(time.time() * 1000)
        # Ensure we don't schedule in the past for newly-created tasks
        from_ms = max(task.created_at, now_ms)
        next_fire = _compute_next_fire_at(task, from_ms, self._config.jitter)
        if next_fire is None:
            raise RuntimeError(f"Cron expression '{task.cron}' does not match any future date")

        self._store.add(task)
        self._task_states[task.id] = _TaskState(task=task, next_fire_at=next_fire)
        logger.info(
            "Loop task added: id={id} cron={cron} recurring={recurring} durable={durable} "
            "next_fire={next}",
            id=task.id,
            cron=task.cron,
            recurring=task.recurring,
            durable=task.durable,
            next=next_fire,
        )

    def remove_task(self, task_id: str) -> LoopTask | None:
        self._task_states.pop(task_id, None)
        return self._store.remove(task_id)

    def list_tasks(self) -> list[LoopTask]:
        return self._store.list_all()

    def get_task(self, task_id: str) -> LoopTask | None:
        return self._store.get(task_id)

    def get_next_fire_time(self) -> int | None:
        """Epoch ms of the soonest pending task, or None."""
        if not self._task_states:
            return None
        return min(s.next_fire_at for s in self._task_states.values())

    # ------------------------------------------------------------------
    # Polling loop
    # ------------------------------------------------------------------

    async def _poll_loop(self) -> None:
        while not self._stopped:
            try:
                await self._tick()
            except Exception:
                logger.exception("Loop scheduler tick failed")
            await asyncio.sleep(1.0)

    async def _tick(self) -> None:
        now_ms = int(time.time() * 1000)

        # Acquire or refresh lock for durable tasks
        self._maybe_acquire_lock()

        # Evict aged recurring tasks
        aged = self._store.evict_aged(self._config.jitter.recurring_max_age_ms, now_ms)
        for task in aged:
            self._task_states.pop(task.id, None)
            logger.info("Loop task aged out and removed: id={id}", id=task.id)

        # Process tasks
        fired: list[LoopTask] = []

        for state in list(self._task_states.values()):
            if state.in_flight:
                continue

            if now_ms < state.next_fire_at:
                continue

            state.in_flight = True
            fired.append(state.task)

        for task in fired:
            await self._fire_task(task)

    async def _fire_task(self, task: LoopTask) -> None:
        logger.info("Loop task firing: id={id} prompt={prompt!r}", id=task.id, prompt=task.prompt)

        if task.agent_id is not None and self._soul is not None:
            # Subagent routing: currently not supported in this iteration
            logger.warning("Loop task agent_id routing is not yet implemented: id={id}", id=task.id)

        # Inject prompt into the soul's message queue
        if self._soul is not None:
            self._soul.steer(task.prompt)

        now_ms = int(time.time() * 1000)
        task.last_fired_at = now_ms

        if task.recurring:
            # Reschedule forward from now
            next_fire = _compute_next_fire_at(task, now_ms, self._config.jitter)
            state = self._task_states.get(task.id)
            if state is not None:
                if next_fire is None:
                    # Cron no longer valid (e.g. exhausted) — remove
                    self._store.remove(task.id)
                    self._task_states.pop(task.id, None)
                    logger.info("Loop task exhausted and removed: id={id}", id=task.id)
                else:
                    state.next_fire_at = next_fire
                    state.in_flight = False
                    self._store.update(task)
                    logger.info(
                        "Loop task rescheduled: id={id} next_fire={next}",
                        id=task.id,
                        next=next_fire,
                    )
        else:
            # One-shot: remove after fire
            self._store.remove(task.id)
            self._task_states.pop(task.id, None)
            logger.info("Loop task completed (one-shot): id={id}", id=task.id)

    # ------------------------------------------------------------------
    # Lock management
    # ------------------------------------------------------------------

    def _maybe_acquire_lock(self) -> None:
        if self._lock is None:
            return
        if self._lock_owned:
            return
        now = time.monotonic()
        if now - self._last_lock_probe < self._lock_probe_interval_s:
            return
        self._last_lock_probe = now
        if self._lock.acquire():
            self._lock_owned = True
            logger.debug("Acquired loop lock")
            self._maybe_load_durable()

    def _maybe_load_durable(self) -> None:
        if self._lock is not None and not self._lock_owned:
            return
        loaded = self._store.load_durable()
        for task in loaded:
            if task.id not in self._task_states:
                from_ms = task.last_fired_at or task.created_at
                next_fire = _compute_next_fire_at(task, from_ms, self._config.jitter)
                if next_fire is not None:
                    self._task_states[task.id] = _TaskState(task=task, next_fire_at=next_fire)

    # ------------------------------------------------------------------
    # Missed task handling
    # ------------------------------------------------------------------

    def check_missed_tasks(self) -> list[LoopTask]:
        """Check for tasks whose first scheduled run from createdAt is in the past.

        Returns one-shot missed tasks that should be surfaced to the user.
        """
        now_ms = int(time.time() * 1000)
        missed: list[LoopTask] = []
        for task in self._store.list_all():
            if not task.recurring and task.last_fired_at is None:
                first_fire = _compute_next_fire_at(task, task.created_at, self._config.jitter)
                if first_fire is not None and first_fire < now_ms:
                    missed.append(task)
        return missed
