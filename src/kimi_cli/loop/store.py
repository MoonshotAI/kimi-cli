from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from kimi_cli.loop.models import LoopTask
from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger


class LoopStore:
    """In-memory and file-backed storage for loop tasks."""

    def __init__(self, session_dir: Path | None = None) -> None:
        self._tasks: dict[str, LoopTask] = {}
        self._session_dir = session_dir
        self._durable_path = session_dir / "scheduled.json" if session_dir else None

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def add(self, task: LoopTask) -> None:
        self._tasks[task.id] = task
        if task.durable:
            self._save_durable()

    def remove(self, task_id: str) -> LoopTask | None:
        task = self._tasks.pop(task_id, None)
        if task is not None and task.durable:
            self._save_durable()
        return task

    def get(self, task_id: str) -> LoopTask | None:
        return self._tasks.get(task_id)

    def list_all(self) -> list[LoopTask]:
        return list(self._tasks.values())

    def count(self) -> int:
        return len(self._tasks)

    def update(self, task: LoopTask) -> None:
        if task.id in self._tasks:
            self._tasks[task.id] = task
            if task.durable:
                self._save_durable()

    # ------------------------------------------------------------------
    # Durable persistence
    # ------------------------------------------------------------------

    def load_durable(self) -> list[LoopTask]:
        """Load durable tasks from disk and merge into memory."""
        if self._durable_path is None or not self._durable_path.exists():
            return []

        try:
            data = json.loads(self._durable_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
            logger.warning(
                "Corrupted loop schedule file, ignoring: {path}: {error}",
                path=self._durable_path,
                error=e,
            )
            return []

        tasks: list[LoopTask] = []
        raw_tasks = data.get("tasks", []) if isinstance(data, dict) else []
        for item in raw_tasks:
            try:
                tasks.append(LoopTask.model_validate(item))
            except Exception as e:
                logger.warning(
                    "Skipping malformed loop task in durable store: {item}: {error}",
                    item=item,
                    error=e,
                )

        for task in tasks:
            self._tasks[task.id] = task

        logger.info("Loaded {count} durable loop task(s)", count=len(tasks))
        return tasks

    def _save_durable(self) -> None:
        if self._durable_path is None:
            return

        durable_tasks = [t for t in self._tasks.values() if t.durable]
        payload: dict[str, Any] = {"tasks": [t.model_dump(mode="json") for t in durable_tasks]}
        atomic_json_write(payload, self._durable_path)

    # ------------------------------------------------------------------
    # House-keeping
    # ------------------------------------------------------------------

    def evict_aged(self, max_age_ms: int, now_ms: int | None = None) -> list[LoopTask]:
        """Remove aged recurring tasks. Returns evicted tasks."""
        if now_ms is None:
            now_ms = int(time.time() * 1000)

        evicted: list[LoopTask] = []
        to_remove: list[str] = []

        for task in self._tasks.values():
            if task.recurring and not task.permanent and (now_ms - task.created_at >= max_age_ms):
                to_remove.append(task.id)
                evicted.append(task)

        for tid in to_remove:
            self._tasks.pop(tid, None)

        if to_remove:
            self._save_durable()

        return evicted
