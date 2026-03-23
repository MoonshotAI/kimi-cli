from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell

DEFAULT_EXPIRY_DAYS = 3


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
    expires_at: float = field(default=0.0)  # Expiration timestamp (0.0 = use default)

    @property
    def next_run_at(self) -> float | None:
        if self.cancelled:
            return None
        if self.last_run_at is None:
            return self.created_at
        return self.last_run_at + self.interval_s

    def __post_init__(self) -> None:
        if self.expires_at == 0.0:
            self.expires_at = self.created_at + (DEFAULT_EXPIRY_DAYS * 86400)

    @property
    def is_complete(self) -> bool:
        if self.cancelled:
            return True
        if self.max_runs is not None and self.run_count >= self.max_runs:
            return True
        if time.time() >= self.expires_at:
            return True
        return False
    
    @property
    def is_expired(self) -> bool:
        """Check if task has expired."""
        return time.time() >= self.expires_at


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
        expires_in: int | None = None,
    ) -> LoopTask:
        """
        Create a new loop task.

        Args:
            interval: Time interval like '5m', '2h', '1d', '30s'
            prompt: The prompt to send to the AI
            max_runs: Maximum number of times to run (None for infinite)
            expires_in: Expiration time in days (None for default 3 days)

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

            created_at = time.time()
            expiry_days = expires_in if expires_in is not None else DEFAULT_EXPIRY_DAYS
            expires_at = created_at + (expiry_days * 86400)

            task = LoopTask(
                id=task_id,
                interval_s=interval_s,
                prompt=prompt,
                created_at=created_at,
                expires_at=expires_at,
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
        from kimi_cli.ui.shell.console import console

        try:
            prompt_preview = task.prompt[:80] + "..." if len(task.prompt) > 80 else task.prompt
            console.print(f"[dim][Loop {task.id}] Running: {prompt_preview}[/dim]")

            # Execute the prompt via the shell
            await self._shell.run_soul_command(task.prompt)

            async with self._lock:
                task.last_run_at = time.time()
                task.run_count += 1

            logger.info(
                "Executed loop task {task_id} (run {run_count}/{max_runs})",
                task_id=task.id,
                run_count=task.run_count,
                max_runs=task.max_runs or "∞",
            )
            
            # Check if task expired after this run
            if task.is_expired:
                console.print(f"[yellow][Loop {task.id}] Task has expired and will be cleaned up.[/yellow]")

        except Exception as e:
            logger.exception("Loop task {task_id} failed", task_id=task.id)
            console.print(f"[red][Loop {task.id}] Failed: {e}[/red]")

    async def _run_scheduler(self) -> None:
        """Main scheduler loop."""
        from kimi_cli.ui.shell.console import console
        
        logger.info("Loop scheduler started")

        while True:
            try:
                expired_count = 0
                async with self._lock:
                    # Clean up completed tasks
                    completed_ids = []
                    for tid, t in self._tasks.items():
                        if t.is_complete:
                            completed_ids.append(tid)
                            if t.is_expired:
                                expired_count += 1
                    
                    for tid in completed_ids:
                        del self._tasks[tid]
                    
                    # Show expiration message
                    if expired_count > 0:
                        console.print(f"[dim][Loop] Cleaned up {expired_count} expired task(s).[/dim]")

                    if not self._tasks:
                        logger.info("No active loop tasks, scheduler stopping")
                        break

                    # Find tasks ready to run (using monotonic clock)
                    now = asyncio.get_event_loop().time()
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

                # Execute ready tasks (re-check is_complete before executing)
                for task in ready_tasks:
                    if task.is_complete:
                        continue
                    # Run without holding the lock to avoid blocking
                    await self._execute_task(task)

                # Calculate sleep time using monotonic clock
                if next_wakeup is not None:
                    sleep_time = max(0.1, next_wakeup - asyncio.get_event_loop().time())
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
