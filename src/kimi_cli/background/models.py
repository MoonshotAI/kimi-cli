from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

type TaskKind = Literal["bash", "agent"]
type TaskStatus = Literal[
    "created",
    "starting",
    "running",
    "awaiting_approval",
    "completed",
    "failed",
    "killed",
    "lost",
]
type TaskOwnerRole = Literal["root", "subagent"]

TERMINAL_TASK_STATUSES: tuple[TaskStatus, ...] = ("completed", "failed", "killed", "lost")


def is_terminal_status(status: TaskStatus) -> bool:
    return status in TERMINAL_TASK_STATUSES


class TaskSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: int = 1
    id: str
    kind: TaskKind
    session_id: str
    description: str
    tool_call_id: str
    owner_role: TaskOwnerRole = "root"
    created_at: float = Field(default_factory=time.time)

    @field_validator("owner_role", mode="before")
    @classmethod
    def _normalize_owner_role(cls, v: str) -> str:
        if v in ("fixed_subagent", "dynamic_subagent"):
            return "subagent"
        return v

    # Bash-specific fields for V1. Future task types can use kind_payload.
    command: str | None = None
    shell_name: str | None = None
    shell_path: str | None = None
    cwd: str | None = None
    timeout_s: int | None = None
    kind_payload: dict[str, Any] | None = None


class TaskRuntime(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: TaskStatus = "created"
    worker_pid: int | None = None
    child_pid: int | None = None
    child_pgid: int | None = None
    started_at: float | None = None
    heartbeat_at: float | None = None
    updated_at: float = Field(default_factory=time.time)
    finished_at: float | None = None
    exit_code: int | None = None
    interrupted: bool = False
    timed_out: bool = False
    failure_reason: str | None = None


class TaskControl(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kill_requested_at: float | None = None
    kill_reason: str | None = None
    force: bool = False


class TaskConsumerState(BaseModel):
    model_config = ConfigDict(extra="ignore")

    last_seen_output_size: int = 0
    last_viewed_at: float | None = None


class TaskView(BaseModel):
    model_config = ConfigDict(extra="ignore")

    spec: TaskSpec
    runtime: TaskRuntime
    control: TaskControl
    consumer: TaskConsumerState


class TaskOutputChunk(BaseModel):
    model_config = ConfigDict(extra="ignore")

    task_id: str
    offset: int
    next_offset: int
    text: str
    eof: bool
    status: TaskStatus
