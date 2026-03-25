import time
from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.background import TaskView, format_task, format_task_list, list_task_views
from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.display import BackgroundTaskDisplayBlock
from kimi_cli.tools.utils import load_desc

TASK_OUTPUT_PREVIEW_BYTES = 32 << 10
TASK_OUTPUT_READ_HINT_LINES = 300


def _ensure_root(runtime: Runtime) -> ToolError | None:
    if runtime.role != "root":
        return ToolError(
            message="Background tasks can only be managed by the root agent.",
            brief="Background task unavailable",
        )
    return None


def _task_display(runtime: Runtime, task_id: str) -> BackgroundTaskDisplayBlock:
    view = runtime.background_tasks.store.merged_view(task_id)
    return BackgroundTaskDisplayBlock(
        task_id=view.spec.id,
        kind=view.spec.kind,
        status=view.runtime.status,
        description=view.spec.description,
    )


def _format_task_output(
    view: TaskView,
    *,
    retrieval_status: str,
    output: str,
    output_path: Path,
    full_output_available: bool,
    output_size_bytes: int,
    output_preview_bytes: int,
    output_truncated: bool,
) -> str:
    terminal_reason = "timed_out" if view.runtime.timed_out else view.runtime.status
    output_path_str = str(output_path.resolve())
    lines = [
        f"retrieval_status: {retrieval_status}",
        f"task_id: {view.spec.id}",
        f"kind: {view.spec.kind}",
        f"status: {view.runtime.status}",
        f"description: {view.spec.description}",
    ]
    if view.spec.kind == "agent" and view.spec.kind_payload:
        if agent_id := view.spec.kind_payload.get("agent_id"):
            lines.append(f"agent_id: {agent_id}")
        if subagent_type := view.spec.kind_payload.get("subagent_type"):
            lines.append(f"subagent_type: {subagent_type}")
    if view.spec.command:
        lines.append(f"command: {view.spec.command}")
    lines.extend(
        [
            f"interrupted: {str(view.runtime.interrupted).lower()}",
            f"timed_out: {str(view.runtime.timed_out).lower()}",
            f"terminal_reason: {terminal_reason}",
        ]
    )
    if view.runtime.exit_code is not None:
        lines.append(f"exit_code: {view.runtime.exit_code}")
    if view.runtime.failure_reason:
        lines.append(f"reason: {view.runtime.failure_reason}")
    full_output_hint = (
        (
            "full_output_hint: "
            f'Use ReadFile(path="{output_path_str}", line_offset=1, '
            f"n_lines={TASK_OUTPUT_READ_HINT_LINES}) to inspect the full log. "
            "Increase line_offset to continue paging through the file."
        )
        if full_output_available
        else "full_output_hint: No output file is currently available for this task."
    )
    lines.extend(
        [
            "",
            f"output_path: {output_path_str}",
            f"output_size_bytes: {output_size_bytes}",
            f"output_preview_bytes: {output_preview_bytes}",
            f"output_truncated: {str(output_truncated).lower()}",
            "",
            f"full_output_available: {str(full_output_available).lower()}",
            "full_output_tool: ReadFile",
            full_output_hint,
        ]
    )
    rendered_output = output or "[no output available]"
    if output_truncated:
        rendered_output = f"[Truncated. Full output: {output_path_str}]\n\n{rendered_output}"
    return "\n".join(
        lines
        + [
            "",
            "[output]",
            rendered_output,
        ]
    )


class TaskOutputParams(BaseModel):
    task_id: str = Field(description="The background task ID to inspect.")
    block: bool = Field(
        default=False,
        description="Whether to wait for the task to finish before returning.",
    )
    timeout: int = Field(
        default=30,
        ge=0,
        le=3600,
        description="Maximum number of seconds to wait when block=true.",
    )


class TaskStopParams(BaseModel):
    task_id: str = Field(description="The background task ID to stop.")
    reason: str = Field(
        default="Stopped by TaskStop",
        description="Short reason recorded when the task is stopped.",
    )


class TaskListParams(BaseModel):
    active_only: bool = Field(
        default=True,
        description="Whether to list only non-terminal background tasks.",
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=100,
        description="Maximum number of tasks to return.",
    )


class TaskList(CallableTool2[TaskListParams]):
    name: str = "TaskList"
    description: str = load_desc(Path(__file__).parent / "list.md")
    params: type[TaskListParams] = TaskListParams

    def __init__(self, runtime: Runtime):
        super().__init__()
        self._runtime = runtime

    @override
    async def __call__(self, params: TaskListParams) -> ToolReturnValue:
        if err := _ensure_root(self._runtime):
            return err

        views = list_task_views(
            self._runtime.background_tasks,
            active_only=params.active_only,
            limit=params.limit,
        )
        display = [
            BackgroundTaskDisplayBlock(
                task_id=view.spec.id,
                kind=view.spec.kind,
                status=view.runtime.status,
                description=view.spec.description,
            )
            for view in views
        ]
        return ToolReturnValue(
            is_error=False,
            output=format_task_list(views, active_only=params.active_only),
            message="Task list retrieved.",
            display=list(display),
        )


class TaskOutput(CallableTool2[TaskOutputParams]):
    name: str = "TaskOutput"
    description: str = load_desc(Path(__file__).parent / "output.md")
    params: type[TaskOutputParams] = TaskOutputParams

    def __init__(self, runtime: Runtime):
        super().__init__()
        self._runtime = runtime

    def _render_output_preview(self, task_id: str) -> tuple[str, bool, int, int, bool, Path]:
        manager = self._runtime.background_tasks
        output_path = manager.resolve_output_path(task_id)
        try:
            output_size = output_path.stat().st_size if output_path.exists() else 0
        except OSError:
            output_size = 0
        preview_offset = max(0, output_size - TASK_OUTPUT_PREVIEW_BYTES)
        chunk = manager.read_output(
            task_id,
            offset=preview_offset,
            max_bytes=TASK_OUTPUT_PREVIEW_BYTES,
        )
        return (
            chunk.text.rstrip("\n"),
            output_size > 0,
            output_size,
            chunk.next_offset - chunk.offset,
            preview_offset > 0,
            output_path,
        )

    @override
    async def __call__(self, params: TaskOutputParams) -> ToolReturnValue:
        if err := _ensure_root(self._runtime):
            return err

        view = self._runtime.background_tasks.get_task(params.task_id)
        if view is None:
            return ToolError(message=f"Task not found: {params.task_id}", brief="Task not found")

        if params.block:
            view = await self._runtime.background_tasks.wait(
                params.task_id,
                timeout_s=params.timeout,
            )
            retrieval_status = (
                "success"
                if view.runtime.status in {"completed", "failed", "killed", "lost"}
                else "timeout"
            )
        else:
            retrieval_status = (
                "success"
                if view.runtime.status in {"completed", "failed", "killed", "lost"}
                else "not_ready"
            )

        (
            output,
            full_output_available,
            output_size,
            output_preview_bytes,
            output_truncated,
            output_path,
        ) = self._render_output_preview(params.task_id)
        consumer = view.consumer.model_copy(
            update={
                "last_seen_output_size": output_size,
                "last_viewed_at": time.time(),
            }
        )
        self._runtime.background_tasks.store.write_consumer(params.task_id, consumer)

        return ToolReturnValue(
            is_error=False,
            output=_format_task_output(
                view,
                retrieval_status=retrieval_status,
                output=output,
                output_path=output_path,
                full_output_available=full_output_available,
                output_size_bytes=output_size,
                output_preview_bytes=output_preview_bytes,
                output_truncated=output_truncated,
            ),
            message=(
                "Task snapshot retrieved."
                if not params.block and retrieval_status == "not_ready"
                else "Task output retrieved."
            ),
            display=[_task_display(self._runtime, params.task_id)],
        )


class TaskStop(CallableTool2[TaskStopParams]):
    name: str = "TaskStop"
    description: str = load_desc(Path(__file__).parent / "stop.md")
    params: type[TaskStopParams] = TaskStopParams

    def __init__(self, runtime: Runtime, approval: Approval):
        super().__init__()
        self._runtime = runtime
        self._approval = approval

    @override
    async def __call__(self, params: TaskStopParams) -> ToolReturnValue:
        if err := _ensure_root(self._runtime):
            return err
        if self._runtime.session.state.plan_mode:
            return ToolError(
                message="TaskStop is not available in plan mode.",
                brief="Blocked in plan mode",
            )

        view = self._runtime.background_tasks.get_task(params.task_id)
        if view is None:
            return ToolError(message=f"Task not found: {params.task_id}", brief="Task not found")

        result = await self._approval.request(
            self.name,
            "stop background task",
            f"Stop background task `{params.task_id}`",
            display=[_task_display(self._runtime, params.task_id)],
        )
        if not result:
            return result.rejection_error()

        view = self._runtime.background_tasks.kill(
            params.task_id,
            reason=params.reason.strip() or "Stopped by TaskStop",
        )
        return ToolReturnValue(
            is_error=False,
            output=format_task(view, include_command=True),
            message="Task stop requested.",
            display=[_task_display(self._runtime, params.task_id)],
        )
