from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


@dataclass
class LoopTask:
    """A scheduled loop task."""

    id: str
    interval_s: float
    prompt: str
    created_at: float = field(default_factory=time.time)
    last_run_at: float | None = None
    run_count: int = 0
    max_runs: int | None = None
    cancelled: bool = False

    @property
    def next_run_at(self) -> float | None:
        if self.cancelled:
            return None
        if self.last_run_at is None:
            return self.created_at
        return self.last_run_at + self.interval_s

    @property
    def is_complete(self) -> bool:
        return self.cancelled or (self.max_runs is not None and self.run_count >= self.max_runs)


class LoopScheduler:
    """
    Session-level scheduler for repeating tasks.
    Similar to Claude Code's /loop command.
    """

    MAX_TASKS = 50

    def __init__(self, shell: Shell) -> None:
        self._shell = shell
        self._tasks: dict[str, LoopTask] = {}
        self._scheduler_task: asyncio.Task[Any] | None = None
        self._lock = asyncio.Lock()

    @property
    def task_count(self) -> int:
        return len(self._tasks)

    def _generate_task_id(self) -> str:
        """Generate a unique task ID."""
        import uuid

        return f"loop_{uuid.uuid4().hex[:8]}"

    def _parse_interval(self, interval_str: str) -> float:
        """
        Parse interval string like '5m', '2h', '1d', '30s' into seconds.
        Minimum is 60 seconds (1 minute).
        """
        interval_str = interval_str.strip().lower()

        # Try to parse as a simple number (minutes)
        try:
            minutes = float(interval_str)
            if minutes <= 0:
                raise ValueError("Interval must be positive")
            return max(60.0, minutes * 60)
        except ValueError:
            pass

        # Parse with unit suffix
        match = re.match(r"^(\d+(?:\.\d+)?)\s*([smhd])$", interval_str)
        if not match:
            raise ValueError(f"Invalid interval format: {interval_str}")

        value = float(match.group(1))
        unit = match.group(2)

        multipliers = {
            "s": 1,
            "m": 60,
            "h": 3600,
            "d": 86400,
        }

        seconds = value * multipliers[unit]
        # Minimum 60 seconds
        return max(60.0, seconds)

    async def create_task(
        self,
        interval: str,
        prompt: str,
        max_runs: int | None = None,
    ) -> LoopTask:
        """
        Create a new loop task.

        Args:
            interval: Time interval like '5m', '2h', '1d', '30s'
            prompt: The prompt to send to the AI
            max_runs: Maximum number of times to run (None for infinite)

        Returns:
            The created LoopTask
        """
        async with self._lock:
            if len(self._tasks) >= self.MAX_TASKS:
                raise RuntimeError(
                    f"Maximum number of loop tasks ({self.MAX_TASKS}) reached. "
                    "Cancel some tasks with /loop-cancel before creating new ones."
                )

            interval_s = self._parse_interval(interval)
            task_id = self._generate_task_id()

            task = LoopTask(
                id=task_id,
                interval_s=interval_s,
                prompt=prompt,
                max_runs=max_runs,
            )
            self._tasks[task_id] = task

            # Start scheduler if not running
            if self._scheduler_task is None or self._scheduler_task.done():
                self._scheduler_task = asyncio.create_task(self._run_scheduler())

            logger.info(
                "Created loop task {task_id}: interval={interval}s, prompt={prompt!r}",
                task_id=task_id,
                interval=interval_s,
                prompt=prompt,
            )

            return task

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a loop task by ID."""
        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return False
            task.cancelled = True
            logger.info("Cancelled loop task {task_id}", task_id=task_id)
            return True

    async def cancel_all_tasks(self) -> int:
        """Cancel all loop tasks. Returns number of tasks cancelled."""
        async with self._lock:
            count = 0
            for task in self._tasks.values():
                if not task.is_complete:
                    task.cancelled = True
                    count += 1
            logger.info("Cancelled all {count} loop tasks", count=count)
            return count

    def get_task(self, task_id: str) -> LoopTask | None:
        """Get a task by ID."""
        return self._tasks.get(task_id)

    def list_tasks(
        self,
        active_only: bool = False,
    ) -> list[LoopTask]:
        """List all tasks, optionally filtering to active (non-complete) tasks only."""
        tasks = list(self._tasks.values())
        if active_only:
            tasks = [t for t in tasks if not t.is_complete]
        return sorted(tasks, key=lambda t: t.created_at)

    async def _execute_task(self, task: LoopTask) -> None:
        """Execute a single loop task."""
        try:
            from kimi_cli.ui.shell.console import console

            prompt_preview = task.prompt[:80] + "..." if len(task.prompt) > 80 else task.prompt
            console.print(f"[dim][Loop {task.id}] Running: {prompt_preview}[/dim]")

            # Execute the prompt via the shell
            await self._shell.run_soul_command(task.prompt)

            task.last_run_at = time.time()
            task.run_count += 1

            logger.info(
                "Executed loop task {task_id} (run {run_count}/{max_runs})",
                task_id=task.id,
                run_count=task.run_count,
                max_runs=task.max_runs or "∞",
            )

        except Exception:
            logger.exception("Loop task {task_id} failed", task_id=task.id)

    async def _run_scheduler(self) -> None:
        """Main scheduler loop."""
        logger.info("Loop scheduler started")

        while True:
            try:
                async with self._lock:
                    # Clean up completed tasks
                    completed_ids = [tid for tid, t in self._tasks.items() if t.is_complete]
                    for tid in completed_ids:
                        del self._tasks[tid]

                    if not self._tasks:
                        logger.info("No active loop tasks, scheduler stopping")
                        break

                    # Find tasks ready to run
                    now = time.time()
                    ready_tasks: list[LoopTask] = []
                    next_wakeup: float | None = None

                    for task in self._tasks.values():
                        if task.is_complete:
                            continue
                        next_run = task.next_run_at
                        if next_run is None:
                            continue
                        if next_run <= now:
                            ready_tasks.append(task)
                        elif next_wakeup is None or next_run < next_wakeup:
                            next_wakeup = next_run

                # Execute ready tasks
                for task in ready_tasks:
                    # Run without holding the lock to avoid blocking
                    await self._execute_task(task)

                # Calculate sleep time
                if next_wakeup is not None:
                    sleep_time = max(0.1, next_wakeup - time.time())
                else:
                    sleep_time = 60.0  # Default check interval

                # Cap sleep time to allow for quick exit
                sleep_time = min(sleep_time, 60.0)

                await asyncio.sleep(sleep_time)

            except asyncio.CancelledError:
                logger.info("Loop scheduler cancelled")
                raise
            except Exception:
                logger.exception("Loop scheduler error")
                await asyncio.sleep(5.0)  # Backoff on error

    def shutdown(self) -> None:
        """Shutdown the scheduler."""
        if self._scheduler_task and not self._scheduler_task.done():
            self._scheduler_task.cancel()
            logger.info("Loop scheduler shutdown requested")


# Global scheduler instance per shell (will be attached to shell instance)
_loop_schedulers: dict[int, LoopScheduler] = {}


def get_loop_scheduler(shell: Shell) -> LoopScheduler:
    """Get or create a loop scheduler for a shell instance."""
    shell_id = id(shell)
    if shell_id not in _loop_schedulers:
        _loop_schedulers[shell_id] = LoopScheduler(shell)
    return _loop_schedulers[shell_id]


def remove_loop_scheduler(shell: Shell) -> None:
    """Remove and shutdown the loop scheduler for a shell instance."""
    shell_id = id(shell)
    if shell_id in _loop_schedulers:
        _loop_schedulers[shell_id].shutdown()
        del _loop_schedulers[shell_id]
