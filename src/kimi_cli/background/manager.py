from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import time
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

    def _mark_task_awaiting_approval(self, task_id: str, reason: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "awaiting_approval"
        runtime.updated_at = time.time()
        runtime.failure_reason = reason
        self._store.write_runtime(task_id, runtime)

    def _mark_task_completed(self, task_id: str) -> None:
        runtime = self._store.read_runtime(task_id)
        if is_terminal_status(runtime.status):
            return
        runtime.status = "completed"
        runtime.updated_at = time.time()
        runtime.finished_at = runtime.updated_at
        runtime.failure_reason = None
        self._store.write_runtime(task_id, runtime)
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
        from kimi_cli.telemetry import track

        if runtime.started_at and runtime.finished_at:
            duration = runtime.finished_at - runtime.started_at
            track(
                "background_task_completed",
                success=False,
                duration_s=duration,
                reason="killed",
            )
