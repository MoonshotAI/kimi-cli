from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kaos.local import local_kaos

from kimi_cli.config import BackgroundConfig
from kimi_cli.notifications import NotificationEvent, NotificationManager
from kimi_cli.session import Session
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime

from .ids import generate_task_id
from .models import (
    TaskOutputChunk,
    TaskRuntime,
    TaskSpec,
    TaskStatus,
    TaskView,
    is_terminal_status,
)
from .store import BackgroundTaskStore


class BackgroundTaskManager:
    def __init__(
        self,
        session: Session,
        config: BackgroundConfig,
        *,
        notifications: NotificationManager,
        owner_role: str = "root",
    ) -> None:
        self._session = session
        self._config = config
        self._notifications = notifications
        self._owner_role = owner_role
        self._store = BackgroundTaskStore(session.context_file.parent / "tasks")
        self._runtime: Runtime | None = None
        self._live_agent_tasks: dict[str, asyncio.Task[None]] = {}
        self._completion_event: asyncio.Event = asyncio.Event()
        # Per-task futures awakened whenever a status transition is observed.
        # Populated by wait_for_status() and resolved by _notify_status_changed().
        self._status_waiters: dict[str, list[asyncio.Future[None]]] = {}
        # Lazily-captured event loop so _notify_status_changed can be called
        # from threads (via asyncio.to_thread) and still reach waiters.
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def completion_event(self) -> asyncio.Event:
        """Event set when a new terminal notification is published.

        Not set immediately when a task becomes terminal — only after
        ``reconcile()`` / ``publish_terminal_notifications()`` runs.
        Deduplicated notifications do not trigger a repeat signal.
        """
        return self._completion_event

    @property
    def store(self) -> BackgroundTaskStore:
        return self._store

    @property
    def role(self) -> str:
        return self._owner_role

    def copy_for_role(self, role: str) -> BackgroundTaskManager:
        manager = BackgroundTaskManager(
            self._session,
            self._config,
            notifications=self._notifications,
            owner_role=role,
        )
        manager._runtime = self._runtime
        return manager

    def bind_runtime(self, runtime: Runtime) -> None:
        self._runtime = runtime

    def _ensure_root(self) -> None:
        if self._owner_role != "root":
            raise RuntimeError("Background tasks are only supported from the root agent.")

    def _ensure_local_backend(self) -> None:
        if self._session.work_dir_meta.kaos != local_kaos.name:
            raise RuntimeError("Background tasks are only supported on local sessions.")

    def _active_task_count(self) -> int:
        return sum(
            1 for view in self._store.list_views() if not is_terminal_status(view.runtime.status)
        )

    def has_active_tasks(self) -> bool:
        """Return True if any background tasks are in a non-terminal status.

        This includes ``running``, ``awaiting_approval``, and any other
        non-terminal state — not just actively executing tasks.
        """
        return self._active_task_count() > 0

    def _worker_command(self, task_dir: Path) -> list[str]:
        if getattr(sys, "frozen", False):
            return [
                sys.executable,
                "__background-task-worker",
                "--task-dir",
                str(task_dir),
                "--heartbeat-interval-ms",
                str(self._config.worker_heartbeat_interval_ms),
                "--control-poll-interval-ms",
                str(self._config.wait_poll_interval_ms),
                "--kill-grace-period-ms",
                str(self._config.kill_grace_period_ms),
            ]
        return [
            sys.executable,
            "-m",
            "kimi_cli.cli",
            "__background-task-worker",
            "--task-dir",
            str(task_dir),
            "--heartbeat-interval-ms",
            str(self._config.worker_heartbeat_interval_ms),
            "--control-poll-interval-ms",
            str(self._config.wait_poll_interval_ms),
            "--kill-grace-period-ms",
            str(self._config.kill_grace_period_ms),
        ]

    def _launch_worker(self, task_dir: Path) -> int:
        kwargs: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "cwd": str(task_dir),
        }
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            kwargs["start_new_session"] = True

        process = subprocess.Popen(self._worker_command(task_dir), **kwargs)
        return process.pid

    def create_bash_task(
        self,
        *,
        command: str,
        description: str,
        timeout_s: int,
        tool_call_id: str,
        shell_name: str,
        shell_path: str,
        cwd: str,
    ) -> TaskView:
        self._ensure_root()
        self._ensure_local_backend()

        if self._active_task_count() >= self._config.max_running_tasks:
            raise RuntimeError("Too many background tasks are already running.")

        task_id = generate_task_id("bash")
        spec = TaskSpec(
            id=task_id,
            kind="bash",
            session_id=self._session.id,
            description=description,
            tool_call_id=tool_call_id,
            owner_role="root",
            command=command,
            shell_name=shell_name,
            shell_path=shell_path,
            cwd=cwd,
            timeout_s=timeout_s,
        )
        self._store.create_task(spec)
        from kimi_cli.telemetry import track

        track("background_task_created")

        runtime = self._store.read_runtime(task_id)
        task_dir = self._store.task_dir(task_id)
        try:
            worker_pid = self._launch_worker(task_dir)
        except Exception as exc:
            runtime.status = "failed"
            runtime.failure_reason = f"Failed to launch worker: {exc}"
            runtime.finished_at = time.time()
            runtime.updated_at = runtime.finished_at
            self._store.write_runtime(task_id, runtime)
            raise

        runtime = self._store.read_runtime(task_id)
        if runtime.finished_at is None and (
            runtime.status == "created"
            or (runtime.status == "starting" and runtime.worker_pid is None)
        ):
            runtime.status = "starting"
            runtime.worker_pid = worker_pid
            runtime.updated_at = time.time()
            self._store.write_runtime(task_id, runtime)
        return self._store.merged_view(task_id)

    def create_agent_task(
        self,
        *,
        agent_id: str,
        subagent_type: str,
        prompt: str,
        description: str,
        tool_call_id: str,
        model_override: str | None,
        timeout_s: int | None = None,
        resumed: bool = False,
    ) -> TaskView:
        from .agent_runner import BackgroundAgentRunner

        self._ensure_root()
        self._ensure_local_backend()
        if self._runtime is None:
            raise RuntimeError("Background task manager is not bound to a runtime.")
        if self._active_task_count() >= self._config.max_running_tasks:
            raise RuntimeError("Too many background tasks are already running.")

        task_id = generate_task_id("agent")
        # Explicit None check — the falsy idiom ``timeout_s or default``
        # would silently promote a caller-supplied ``0`` to the agent
        # default, matching the analogous fix in Print's wait-cap reader.
        effective_timeout = (
            timeout_s if timeout_s is not None else self._config.agent_task_timeout_s
        )
        spec = TaskSpec(
            id=task_id,
            kind="agent",
            session_id=self._session.id,
            description=description,
            tool_call_id=tool_call_id,
            owner_role="root",
            # Persist the effective timeout so downstream readers (e.g. the
            # Print-mode ``print_wait_ceiling_s`` cap calculation) can honour
            # an explicit per-agent timeout instead of always falling back to
            # ``config.background.agent_task_timeout_s``.
            timeout_s=effective_timeout,
            kind_payload={
                "agent_id": agent_id,
                "subagent_type": subagent_type,
                "prompt": prompt,
                "model_override": model_override,
                "launch_mode": "background",
            },
        )
        self._store.create_task(spec)
        runtime = self._store.read_runtime(task_id)
        runtime.status = "starting"
        runtime.updated_at = time.time()
        self._store.write_runtime(task_id, runtime)
        task = asyncio.create_task(
            BackgroundAgentRunner(
                runtime=self._runtime,
                manager=self,
                task_id=task_id,
                agent_id=agent_id,
                subagent_type=subagent_type,
                prompt=prompt,
                model_override=model_override,
                timeout_s=effective_timeout,
                resumed=resumed,
            ).run()
        )
        self._live_agent_tasks[task_id] = task
        # Cleanup safety net for the case where the runner is cancelled before
        # its first event-loop step. Python throws CancelledError into a
        # FRAME_CREATED coroutine without executing any of the function body,
        # so the runner's finally block never runs and cannot pop the entry
        # itself. The done callback fires regardless of how the task ends, and
        # is idempotent with the runner's own pop (both use pop(..., None)).
        task.add_done_callback(lambda _t, tid=task_id: self._live_agent_tasks.pop(tid, None))
        return self._store.merged_view(task_id)

    def list_tasks(
        self,
        *,
        status: TaskStatus | None = None,
        limit: int | None = 20,
    ) -> list[TaskView]:
        tasks = self._store.list_views()
        if status is not None:
            tasks = [task for task in tasks if task.runtime.status == status]
        if limit is None:
            return tasks
        return tasks[:limit]

    def get_task(self, task_id: str) -> TaskView | None:
        try:
            return self._store.merged_view(task_id)
        except (FileNotFoundError, ValueError):
            return None

    def resolve_output_path(self, task_id: str) -> Path:
        """Return the canonical output path for *task_id*."""
        return self._store.output_path(task_id)

    def read_output(
        self,
        task_id: str,
        *,
        offset: int = 0,
        max_bytes: int | None = None,
    ) -> TaskOutputChunk:
        view = self._store.merged_view(task_id)
        return self._store.read_output(
            task_id,
            offset,
            max_bytes or self._config.read_max_bytes,
            status=view.runtime.status,
        )

    def tail_output(
        self,
        task_id: str,
        *,
        max_bytes: int | None = None,
        max_lines: int | None = None,
    ) -> str:
        self._store.merged_view(task_id)
        return self._store.tail_output(
            task_id,
            max_bytes=max_bytes or self._config.read_max_bytes,
            max_lines=max_lines or self._config.notification_tail_lines,
        )

    async def wait(self, task_id: str, *, timeout_s: int = 30) -> TaskView:
        end_time = time.monotonic() + timeout_s
        while True:
            view = self._store.merged_view(task_id)
            if is_terminal_status(view.runtime.status):
                return view
            if time.monotonic() >= end_time:
                return view
            await asyncio.sleep(self._config.wait_poll_interval_ms / 1000)

    async def wait_for_status(
        self,
        task_id: str,
        target: TaskStatus | Callable[[TaskStatus], bool],
        *,
        timeout_s: float = 5.0,
    ) -> TaskView:
        """Await until the task's status matches ``target``, or raise ``TimeoutError``.

        ``target`` is either a specific ``TaskStatus`` or a predicate over the
        current status. The wait is event-driven: the ``_mark_task_*`` writers
        on *this* manager instance call :meth:`_notify_status_changed` after
        updating the store, which resolves any pending futures registered here.

        Scope (important):
            This primitive only observes transitions that are produced by
            ``_mark_task_*`` on the same manager instance. It is intended for
            agent-task transitions driven in-process by ``BackgroundAgentRunner``
            (notably ``"awaiting_approval"`` and the terminal statuses emitted
            by ``_mark_task_{completed,failed,killed,timed_out}``).

            Transitions written directly through the store bypass the notifier
            and will NOT wake waiters here. Known bypass paths include:

            * bash worker process updates to ``runtime.json`` (a separate
              process; heartbeats, exit status, etc.)
            * initial ``"starting"`` writes in ``create_bash_task`` and
              ``create_agent_task``
            * ``recover()`` writes of ``"lost"``/``"killed"`` for orphaned
              tasks on startup

            For observing statuses produced by any of those paths, use
            :meth:`wait` (polling-based, terminal-only) instead.
        """
        if callable(target):
            predicate: Callable[[TaskStatus], bool] = target
        else:
            target_status = target

            def _match(status: TaskStatus) -> bool:
                return status == target_status

            predicate = _match

        loop = asyncio.get_running_loop()
        self._loop = loop  # lazy capture so thread-side notifiers can reach us
        deadline = loop.time() + timeout_s
        while True:
            # Register the waiter BEFORE reading the store, so a notification
            # that fires between our read and the registration cannot be lost.
            # If the target was already reached (or reached between registration
            # and this check), the post-registration merged_view below returns
            # it immediately.
            fut: asyncio.Future[None] = loop.create_future()
            waiters = self._status_waiters.setdefault(task_id, [])
            waiters.append(fut)
            try:
                view = self._store.merged_view(task_id)
                if predicate(view.runtime.status):
                    return view
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise TimeoutError(
                        f"Timed out after {timeout_s}s waiting for status on task "
                        f"{task_id!r}; current status: {view.runtime.status!r}"
                    )
                try:
                    await asyncio.wait_for(fut, timeout=remaining)
                except TimeoutError:
                    # Loop around for a final predicate check; if still not
                    # matching, the remaining<=0 branch above raises with a
                    # descriptive message.
                    continue
            finally:
                # Drop our future from the waiter list so timed-out or cancelled
                # waits don't accumulate stale entries. _resolve_status_waiters
                # pops the whole list, so if it already fired this is a no-op.
                current = self._status_waiters.get(task_id)
                if current is not None:
                    with contextlib.suppress(ValueError):
                        current.remove(fut)
                    if not current:
                        self._status_waiters.pop(task_id, None)
                # If we're returning via an early predicate-match (or any other
                # path that never awaited the future), cancel it so it doesn't
                # get GC'd while still pending and emit 'Future was destroyed
                # but it is pending!' via the loop's exception handler.
                if not fut.done():
                    fut.cancel()

    def _notify_status_changed(self, task_id: str) -> None:
        """Wake any :meth:`wait_for_status` waiters for this task.

        Safe to call from the event loop or from another thread (e.g. via
        ``asyncio.to_thread``). If the manager has not yet observed its event
        loop (no ``wait_for_status`` call has been made), the notification is a
        no-op because there cannot be any waiters.
        """
        # Use getattr so minimally-constructed instances (e.g. test harnesses
        # that bypass __init__) cannot turn a best-effort notification into a
        # real AttributeError.
        if not getattr(self, "_status_waiters", None):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = getattr(self, "_loop", None)
            if loop is None or loop.is_closed():
                return
            # call_soon_threadsafe can still race with loop shutdown and raise
            # RuntimeError if the loop is closed between the check above and
            # the scheduling call. Treat that as a best-effort no-op so a
            # background agent_runner thread does not surface a spurious error.
            try:
                loop.call_soon_threadsafe(self._resolve_status_waiters, task_id)
            except RuntimeError:
                return
            return
        self._loop = loop
        self._resolve_status_waiters(task_id)

    def _resolve_status_waiters(self, task_id: str) -> None:
        waiters = getattr(self, "_status_waiters", None)
        if waiters is None:
            return
        for fut in waiters.pop(task_id, []):
            if not fut.done():
                fut.set_result(None)

    def _best_effort_kill(self, runtime: TaskRuntime) -> None:
        try:
            if os.name == "nt":
                pid = runtime.child_pid or runtime.worker_pid
                if pid is None:
                    return
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                return

            if runtime.child_pgid is not None:
                os.killpg(runtime.child_pgid, signal.SIGTERM)
                return
            if runtime.child_pid is not None:
                os.kill(runtime.child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception:
            logger.exception("Failed to send best-effort kill signal")

    def kill(self, task_id: str, *, reason: str = "Killed by user") -> TaskView:
        self._ensure_root()
        view = self._store.merged_view(task_id)
        if is_terminal_status(view.runtime.status):
            return view

        if view.spec.kind == "agent":
            self._mark_task_killed(task_id, reason)
            if self._runtime is not None and self._runtime.approval_runtime is not None:
                self._runtime.approval_runtime.cancel_by_source("background_agent", task_id)
            # Keep the task in _live_agent_tasks until BackgroundAgentRunner's
            # finally block removes it. asyncio holds tasks in a WeakSet, so if
            # we drop the only strong reference here the still-pending task can
            # be garbage-collected before cancellation propagates, which fires
            # loop.call_exception_handler with no 'exception' field — surfacing
            # as "Unhandled exception in event loop / Exception None" in the
            # prompt_toolkit terminal.
            task = self._live_agent_tasks.get(task_id)
            if task is not None:
                task.cancel()
            return self._store.merged_view(task_id)

        control = view.control.model_copy(
            update={
                "kill_requested_at": time.time(),
                "kill_reason": reason,
                "force": False,
            }
        )
        self._store.write_control(task_id, control)
        self._best_effort_kill(view.runtime)
        return self._store.merged_view(task_id)

    def kill_all_active(self, *, reason: str = "CLI session ended") -> list[str]:
        """Kill all non-terminal background tasks. Used during CLI shutdown."""
        killed: list[str] = []
        for view in self._store.list_views():
            if is_terminal_status(view.runtime.status):
                continue
            try:
                self.kill(view.spec.id, reason=reason)
                killed.append(view.spec.id)
            except Exception:
                logger.exception(
                    "Failed to kill task {task_id} during shutdown",
                    task_id=view.spec.id,
                )
        return killed

    def recover(self) -> None:
        now = time.time()
        stale_after = self._config.worker_stale_after_ms / 1000
        for view in self._store.list_views():
            if is_terminal_status(view.runtime.status):
                continue
            if view.spec.kind == "agent":
                if view.spec.id in self._live_agent_tasks:
                    continue
                runtime = view.runtime.model_copy()
                runtime.finished_at = now
                runtime.updated_at = now
                runtime.status = "lost"
                runtime.failure_reason = "In-process background agent is no longer running"
                self._store.write_runtime(view.spec.id, runtime)
                agent_id = (view.spec.kind_payload or {}).get("agent_id")
                if (
                    isinstance(agent_id, str)
                    and self._runtime is not None
                    and self._runtime.subagent_store is not None
                ):
                    record = self._runtime.subagent_store.get_instance(agent_id)
                    if record is not None and record.status == "running_background":
                        self._runtime.subagent_store.update_instance(agent_id, status="failed")
                continue
            last_progress_at = (
                view.runtime.heartbeat_at
                or view.runtime.started_at
                or view.runtime.updated_at
                or view.spec.created_at
            )
            if now - last_progress_at <= stale_after:
                continue

            # Re-read runtime to narrow the race window with the worker process.
            fresh_runtime = self._store.read_runtime(view.spec.id)
            if is_terminal_status(fresh_runtime.status):
                continue
            fresh_progress = (
                fresh_runtime.heartbeat_at
                or fresh_runtime.started_at
                or fresh_runtime.updated_at
                or view.spec.created_at
            )
            if now - fresh_progress <= stale_after:
                continue

            runtime = fresh_runtime.model_copy()
            runtime.finished_at = now
            runtime.updated_at = now
            if view.control.kill_requested_at is not None:
                runtime.status = "killed"
                runtime.interrupted = True
                runtime.failure_reason = view.control.kill_reason or "Killed during recovery"
            else:
                runtime.status = "lost"
                runtime.failure_reason = (
                    "Background worker never heartbeat after startup"
                    if fresh_runtime.heartbeat_at is None
                    else "Background worker heartbeat expired"
                )
            self._store.write_runtime(view.spec.id, runtime)

    def reconcile(self, *, limit: int | None = None) -> list[str]:
        self.recover()
        return self.publish_terminal_notifications(limit=limit)

    def publish_terminal_notifications(self, *, limit: int | None = None) -> list[str]:
        published: list[str] = []
        for view in self._store.list_views():
            if not is_terminal_status(view.runtime.status):
                continue

            status = view.runtime.status
            terminal_reason = "timed_out" if view.runtime.timed_out else status
            match terminal_reason:
                case "completed":
                    severity = "success"
                    title = f"Background task completed: {view.spec.description}"
                case "timed_out":
                    severity = "error"
                    title = f"Background task timed out: {view.spec.description}"
                case "failed":
                    severity = "error"
                    title = f"Background task failed: {view.spec.description}"
                case "killed":
                    severity = "warning"
                    title = f"Background task stopped: {view.spec.description}"
                case "lost":
                    severity = "warning"
                    title = f"Background task lost: {view.spec.description}"
                case _:
                    severity = "info"
                    title = f"Background task updated: {view.spec.description}"

            body_lines = [
                f"Task ID: {view.spec.id}",
                f"Status: {status}",
                f"Description: {view.spec.description}",
            ]
            if terminal_reason != status:
                body_lines.append(f"Terminal reason: {terminal_reason}")
            if view.runtime.exit_code is not None:
                body_lines.append(f"Exit code: {view.runtime.exit_code}")
            if view.runtime.failure_reason:
                body_lines.append(f"Failure reason: {view.runtime.failure_reason}")

            event = NotificationEvent(
                id=self._notifications.new_id(),
                category="task",
                type=f"task.{terminal_reason}",
                source_kind="background_task",
                source_id=view.spec.id,
                title=title,
                body="\n".join(body_lines),
                severity=severity,
                payload={
                    "task_id": view.spec.id,
                    "task_kind": view.spec.kind,
                    "status": status,
                    "description": view.spec.description,
                    "exit_code": view.runtime.exit_code,
                    "interrupted": view.runtime.interrupted,
                    "timed_out": view.runtime.timed_out,
                    "terminal_reason": terminal_reason,
                    "failure_reason": view.runtime.failure_reason,
                },
                dedupe_key=f"background_task:{view.spec.id}:{terminal_reason}",
            )
            notification = self._notifications.publish(event)
            if notification.event.id == event.id:
                published.append(notification.event.id)
                self._completion_event.set()
            if limit is not None and len(published) >= limit:
                break
        return published

    def _mark_task_running(self, task_id: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "running"
        runtime.updated_at = time.time()
        runtime.heartbeat_at = runtime.updated_at
        runtime.failure_reason = None
        self._store.write_runtime(task_id, runtime)
        self._notify_status_changed(task_id)

    def _mark_task_awaiting_approval(self, task_id: str, reason: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "awaiting_approval"
        runtime.updated_at = time.time()
        runtime.failure_reason = reason
        self._store.write_runtime(task_id, runtime)
        self._notify_status_changed(task_id)

    def _mark_task_completed(self, task_id: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "completed"
        runtime.updated_at = time.time()
        runtime.finished_at = runtime.updated_at
        runtime.failure_reason = None
        self._store.write_runtime(task_id, runtime)
        self._notify_status_changed(task_id)
        from kimi_cli.telemetry import track

        if runtime.started_at and runtime.finished_at:
            duration = runtime.finished_at - runtime.started_at
            track("background_task_completed", success=True, duration_s=duration)

    def _mark_task_failed(self, task_id: str, reason: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "failed"
        runtime.updated_at = time.time()
        runtime.finished_at = runtime.updated_at
        runtime.failure_reason = reason
        self._store.write_runtime(task_id, runtime)
        self._notify_status_changed(task_id)
        from kimi_cli.telemetry import track

        if runtime.started_at and runtime.finished_at:
            duration = runtime.finished_at - runtime.started_at
            track(
                "background_task_completed",
                success=False,
                duration_s=duration,
                reason="error",
            )

    def _mark_task_timed_out(self, task_id: str, reason: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "failed"
        runtime.updated_at = time.time()
        runtime.finished_at = runtime.updated_at
        runtime.interrupted = True
        runtime.timed_out = True
        runtime.failure_reason = reason
        self._store.write_runtime(task_id, runtime)
        self._notify_status_changed(task_id)
        from kimi_cli.telemetry import track

        if runtime.started_at and runtime.finished_at:
            duration = runtime.finished_at - runtime.started_at
            track(
                "background_task_completed",
                success=False,
                duration_s=duration,
                reason="timeout",
            )

    def _mark_task_killed(self, task_id: str, reason: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "killed"
        runtime.updated_at = time.time()
        runtime.finished_at = runtime.updated_at
        runtime.interrupted = True
        runtime.failure_reason = reason
        self._store.write_runtime(task_id, runtime)
        self._notify_status_changed(task_id)
        from kimi_cli.telemetry import track

        if runtime.started_at and runtime.finished_at:
            duration = runtime.finished_at - runtime.started_at
            track(
                "background_task_completed",
                success=False,
                duration_s=duration,
                reason="killed",
            )
