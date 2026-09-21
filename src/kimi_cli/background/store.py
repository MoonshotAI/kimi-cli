from __future__ import annotations

import os
import re
from pathlib import Path

from pydantic import BaseModel, ValidationError

from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

from .models import (
    TaskConsumerState,
    TaskControl,
    TaskOutputChunk,
    TaskRuntime,
    TaskSpec,
    TaskStatus,
    TaskView,
)

_VALID_TASK_ID = re.compile(r"^[a-z0-9][a-z0-9\-]{1,24}$")


def _validate_task_id(task_id: str) -> None:
    if not _VALID_TASK_ID.match(task_id):
        raise ValueError(f"Invalid task_id: {task_id!r}")


class BackgroundTaskStore:
    SPEC_FILE = "spec.json"
    RUNTIME_FILE = "runtime.json"
    CONTROL_FILE = "control.json"
    CONSUMER_FILE = "consumer.json"
    OUTPUT_FILE = "output.log"

    def __init__(self, root: Path):
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def _ensure_root(self) -> Path:
        """Return the root directory, creating it if it does not exist."""
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root

    def task_dir(self, task_id: str) -> Path:
        _validate_task_id(task_id)
        path = self._ensure_root() / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def task_path(self, task_id: str) -> Path:
        _validate_task_id(task_id)
        return self.root / task_id

    def spec_path(self, task_id: str) -> Path:
        return self.task_path(task_id) / self.SPEC_FILE

    def runtime_path(self, task_id: str) -> Path:
        return self.task_path(task_id) / self.RUNTIME_FILE

    def control_path(self, task_id: str) -> Path:
        return self.task_path(task_id) / self.CONTROL_FILE

    def consumer_path(self, task_id: str) -> Path:
        return self.task_path(task_id) / self.CONSUMER_FILE

    def output_path(self, task_id: str) -> Path:
        return self.task_path(task_id) / self.OUTPUT_FILE

    def create_task(self, spec: TaskSpec) -> None:
        task_dir = self.task_dir(spec.id)
        atomic_json_write(spec.model_dump(mode="json"), task_dir / self.SPEC_FILE)
        atomic_json_write(TaskRuntime().model_dump(mode="json"), task_dir / self.RUNTIME_FILE)
        atomic_json_write(TaskControl().model_dump(mode="json"), task_dir / self.CONTROL_FILE)
        atomic_json_write(
            TaskConsumerState().model_dump(mode="json"),
            task_dir / self.CONSUMER_FILE,
        )
        self.output_path(spec.id).touch(exist_ok=True)

    def list_task_ids(self) -> list[str]:
        if not self.root.exists():
            return []
        task_ids: list[str] = []
        for path in sorted(self.root.iterdir()):
            if not path.is_dir():
                continue
            if not (path / self.SPEC_FILE).exists():
                continue
            task_ids.append(path.name)
        return task_ids

    def write_spec(self, spec: TaskSpec) -> None:
        atomic_json_write(spec.model_dump(mode="json"), self.spec_path(spec.id))

    def read_spec(self, task_id: str) -> TaskSpec:
        return TaskSpec.model_validate_json(self.spec_path(task_id).read_text(encoding="utf-8"))

    def write_runtime(self, task_id: str, runtime: TaskRuntime) -> None:
        atomic_json_write(runtime.model_dump(mode="json"), self.runtime_path(task_id))

    def read_runtime(self, task_id: str) -> TaskRuntime:
        path = self.runtime_path(task_id)
        if not path.exists():
            return TaskRuntime()
        return _read_json_model(
            path,
            TaskRuntime,
            fallback=TaskRuntime(updated_at=0),
            artifact="task runtime",
        )

    def write_control(self, task_id: str, control: TaskControl) -> None:
        atomic_json_write(control.model_dump(mode="json"), self.control_path(task_id))

    def read_control(self, task_id: str) -> TaskControl:
        path = self.control_path(task_id)
        if not path.exists():
            return TaskControl()
        return _read_json_model(
            path,
            TaskControl,
            fallback=TaskControl(),
            artifact="task control",
        )

    def write_consumer(self, task_id: str, consumer: TaskConsumerState) -> None:
        atomic_json_write(consumer.model_dump(mode="json"), self.consumer_path(task_id))

    def read_consumer(self, task_id: str) -> TaskConsumerState:
        path = self.consumer_path(task_id)
        if not path.exists():
            return TaskConsumerState()
        return _read_json_model(
            path,
            TaskConsumerState,
            fallback=TaskConsumerState(),
            artifact="task consumer state",
        )

    def merged_view(self, task_id: str) -> TaskView:
        return TaskView(
            spec=self.read_spec(task_id),
            runtime=self.read_runtime(task_id),
            control=self.read_control(task_id),
            consumer=self.read_consumer(task_id),
        )

    def list_views(self) -> list[TaskView]:
        views: list[TaskView] = []
        for task_id in self.list_task_ids():
            try:
                views.append(self.merged_view(task_id))
            except (OSError, ValidationError, ValueError, UnicodeDecodeError) as exc:
                logger.warning(
                    "Skipping invalid background task {task_id} from {path}: {error}",
                    task_id=task_id,
                    path=self.root / task_id / self.SPEC_FILE,
                    error=exc,
                )
        views.sort(
            key=lambda view: view.runtime.updated_at or view.spec.created_at,
            reverse=True,
        )
        return views

    def read_output(
        self,
        task_id: str,
        offset: int,
        max_bytes: int,
        *,
        status: TaskStatus,
        path_override: Path | None = None,
    ) -> TaskOutputChunk:
        path = path_override if path_override is not None else self.output_path(task_id)
        if not path.exists():
            return TaskOutputChunk(
                task_id=task_id,
                offset=offset,
                next_offset=offset,
                text="",
                eof=True,
                status=status,
            )

        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            total_size = f.tell()
            bounded_offset = min(max(offset, 0), total_size)
            f.seek(bounded_offset)
            content = f.read(max_bytes)

        next_offset = bounded_offset + len(content)
        return TaskOutputChunk(
            task_id=task_id,
            offset=bounded_offset,
            next_offset=next_offset,
            text=content.decode("utf-8", errors="replace"),
            eof=next_offset >= total_size,
            status=status,
        )

    def tail_output(self, task_id: str, max_bytes: int, max_lines: int) -> str:
        path = self.output_path(task_id)
        if not path.exists():
            return ""

        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            total_size = f.tell()
            start = max(0, total_size - max_bytes)
            f.seek(start)
            content = f.read()

        text = content.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if len(lines) > max_lines:
            lines = lines[-max_lines:]
        return "\n".join(lines)


def _read_json_model[T: BaseModel](path: Path, model: type[T], *, fallback: T, artifact: str) -> T:
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError, UnicodeDecodeError) as exc:
        logger.warning(
            "Failed to read {artifact} from {path}; using defaults: {error}",
            artifact=artifact,
            path=path,
            error=exc,
        )
        return fallback
