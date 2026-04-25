from __future__ import annotations

import asyncio
import re
import time
import uuid
from dataclasses import dataclass, field

from kaos.path import KaosPath
from kosong.message import Message

from kimi_cli.utils.logging import logger

_MAX_LOOP_TASKS = 50
_LOOP_EXPIRY_SECONDS = 7 * 24 * 60 * 60
_LOOP_MD_MAX_BYTES = 25_000


@dataclass(slots=True, kw_only=True)
class LoopTask:
    id: str
    prompt: str
    interval_seconds: float
    created_at: float
    recurring: bool = True
    iterations: int = 0
    _last_fired: float = 0.0
    _cancelled: bool = False
    _jitter_seconds: float = 0.0

    def __post_init__(self) -> None:
        jitter_max = min(self.interval_seconds * 0.10, 60.0)
        jitter_seed = int(self.id[:8], 16)
        self._jitter_seconds = (jitter_seed % 1000) / 1000.0 * jitter_max

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def expired(self) -> bool:
        return (time.monotonic() - self.created_at) > _LOOP_EXPIRY_SECONDS

    def next_fire_time(self) -> float:
        base = self._last_fired if self._last_fired > 0 else self.created_at
        return base + self.interval_seconds + self._jitter_seconds

    def mark_fired(self) -> None:
        self._last_fired = time.monotonic()
        self.iterations += 1

    def was_not_fired_at(self, ts: float) -> bool:
        return self._last_fired != ts

    @property
    def display_interval(self) -> str:
        return _format_duration(self.interval_seconds)

    def describe(self) -> str:
        kind = "recurring" if self.recurring else "one-shot"
        status = "cancelled" if self._cancelled else ("expired" if self.expired else "active")
        return (
            f"[{self.id}] {kind} every {self.display_interval} — {status} "
            f"({self.iterations} iteration(s))\n    Prompt: {self.prompt[:120]}"
        )


@dataclass
class LoopScheduler:
    tasks: dict[str, LoopTask] = field(default_factory=dict[str, LoopTask])
    _fire_event: asyncio.Event = field(default_factory=asyncio.Event)
    _pending_prompts: list[tuple[str, str]] = field(default_factory=list[tuple[str, str]])

    @property
    def fire_event(self) -> asyncio.Event:
        return self._fire_event

    def create_task(
        self,
        prompt: str,
        interval_seconds: float,
        *,
        recurring: bool = True,
    ) -> LoopTask:
        if len(self.tasks) >= _MAX_LOOP_TASKS:
            raise ValueError(f"Maximum number of loop tasks ({_MAX_LOOP_TASKS}) reached")
        task_id = uuid.uuid4().hex[:8]
        task = LoopTask(
            id=task_id,
            prompt=prompt,
            interval_seconds=interval_seconds,
            created_at=time.monotonic(),
            recurring=recurring,
        )
        self.tasks[task_id] = task
        logger.info(
            "Loop task created: {id} every {interval}s",
            id=task_id,
            interval=interval_seconds,
        )
        return task

    def enqueue_first(self, task: LoopTask) -> None:
        task.mark_fired()
        self._pending_prompts.append((task.id, task.prompt))
        self._fire_event.set()

    def cancel_task(self, task_id: str) -> LoopTask | None:
        task = self.tasks.pop(task_id, None)
        if task is None:
            return None
        task.cancel()
        self._pending_prompts = [(tid, p) for tid, p in self._pending_prompts if tid != task_id]
        logger.info("Loop task cancelled: {id}", id=task_id)
        return task

    def cancel_all(self) -> int:
        count = 0
        for task in self.tasks.values():
            if not task.cancelled:
                task.cancel()
                count += 1
        self.tasks.clear()
        self._pending_prompts.clear()
        logger.info("Cancelled {count} loop task(s)", count=count)
        return count

    def pop_due_prompt(self) -> tuple[str, str] | None:
        if self._pending_prompts:
            return self._pending_prompts.pop(0)
        return None

    def tick(self) -> int:
        now = time.monotonic()
        fired = 0
        expired_ids: list[str] = []
        pending_ids = {tid for tid, _ in self._pending_prompts}
        for task_id, task in self.tasks.items():
            if task.cancelled:
                continue
            if task.expired:
                expired_ids.append(task_id)
                continue
            if task_id in pending_ids:
                continue
            if now >= task.next_fire_time() and task.was_not_fired_at(now):
                task.mark_fired()
                self._pending_prompts.append((task.id, task.prompt))
                fired += 1
                if not task.recurring:
                    expired_ids.append(task_id)
        for eid in expired_ids:
            task = self.tasks.pop(eid, None)
            if task and not task.cancelled:
                logger.info("Loop task expired: {id}", id=eid)
        if fired:
            self._fire_event.set()
        return fired

    def list_tasks(self) -> list[LoopTask]:
        return [t for t in self.tasks.values() if not t.cancelled and not t.expired]

    @property
    def has_pending(self) -> bool:
        return bool(self._pending_prompts)

    def clear_fire_event(self) -> None:
        self._fire_event.clear()


def parse_interval(text: str) -> tuple[float | None, str]:
    text = text.strip()
    if not text:
        return None, ""

    patterns = [
        (r"^(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?)\s+", 86400.0),
        (r"^(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)\s+", 3600.0),
        (r"^(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)\s+", 60.0),
        (r"^(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)\s+", 1.0),
        (r"^(\d+(?:\.\d+)?)d\s+", 86400.0),
        (r"^(\d+(?:\.\d+)?)h\s+", 3600.0),
        (r"^(\d+(?:\.\d+)?)m\s+", 60.0),
        (r"^(\d+(?:\.\d+)?)s\s+", 1.0),
        (r"^(?:(\d+(?:\.\d+)?)d)", 86400.0),
        (r"^(?:(\d+(?:\.\d+)?)h)", 3600.0),
        (r"^(?:(\d+(?:\.\d+)?)m)", 60.0),
        (r"^(?:(\d+(?:\.\d+)?)s)", 1.0),
    ]
    for pattern, multiplier in patterns:
        m = re.match(pattern, text, re.IGNORECASE)
        if m:
            value = float(m.group(1))
            seconds = value * multiplier
            remaining = text[m.end() :].strip()
            if seconds < 60.0:
                seconds = 60.0
            return seconds, remaining

    return None, text


def build_loop_user_message(prompt: str, iteration: int, task_id: str) -> Message:
    system_prefix = (
        f"<system>"
        f"Loop iteration #{iteration} (task {task_id}). "
        f"Continue the task from the prompt below, using the existing session context. "
        f"Do NOT start from scratch — build on what has already been done.\n\n"
        f"</system>"
    )
    content = f"{system_prefix}{prompt}"
    return Message(role="user", content=content)


async def load_loop_md(work_dir: KaosPath) -> str | None:
    candidates = [
        work_dir / ".kimi" / "loop.md",
        work_dir / ".claude" / "loop.md",
        KaosPath.home() / ".kimi" / "loop.md",
        KaosPath.home() / ".claude" / "loop.md",
    ]
    for path in candidates:
        try:
            if await path.is_file():
                content = (await path.read_text(encoding="utf-8")).strip()
                if content:
                    if len(content.encode("utf-8")) > _LOOP_MD_MAX_BYTES:
                        content = content.encode("utf-8")[:_LOOP_MD_MAX_BYTES].decode(
                            errors="ignore"
                        )
                    logger.info("Loaded loop.md from {path}", path=path)
                    return content
        except OSError:
            continue
    return None


BUILTIN_MAINTENANCE_PROMPT = (
    "Run a maintenance check on the current session and project. In order:\n"
    "1. Continue any unfinished work from the conversation.\n"
    "2. Check the current branch's pull request (if any): review comments, "
    "failed CI runs, merge conflicts.\n"
    "3. Run cleanup passes (bug hunts, simplification) when nothing else is pending.\n"
    "Do not start new initiatives outside this scope. "
    "Irreversible actions (push, delete) only proceed when continuing something "
    "the conversation already authorized.\n"
    "Summarize what you found and what (if anything) you did."
)


def _format_duration(seconds: float) -> str:
    if seconds >= 86400:
        days = seconds / 86400
        return f"{days:.0f}d" if days == int(days) else f"{days:.1f}d"
    if seconds >= 3600:
        hours = seconds / 3600
        return f"{hours:.0f}h" if hours == int(hours) else f"{hours:.1f}h"
    minutes = seconds / 60
    return f"{minutes:.0f}m" if minutes == int(minutes) else f"{minutes:.1f}m"
