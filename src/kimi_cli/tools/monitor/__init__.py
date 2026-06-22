from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.background.models import MonitorPayload
from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.display import BackgroundTaskDisplayBlock
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.environment import Environment


class MonitorParams(BaseModel):
    command: str = Field(
        description=(
            "Shell command to monitor. Each stdout line is an event; "
            "the command should self-filter (e.g. grep --line-buffered)."
        )
    )
    description: str = Field(description="Short description shown in every notification.")
    timeout_ms: int = Field(
        default=300000,
        ge=1000,
        le=3600000,
        description="Kill the monitor after this deadline. Ignored when persistent=true.",
    )
    persistent: bool = Field(
        default=False,
        description="Run for the lifetime of the session (no timeout). Stop with TaskStop.",
    )


class Monitor(CallableTool2[MonitorParams]):
    name: str = "Monitor"
    description: str = load_desc(Path(__file__).parent / "monitor.md")
    params: type[MonitorParams] = MonitorParams

    def __init__(self, approval: Approval, environment: Environment, runtime: Runtime):
        super().__init__()
        self._approval = approval
        self._shell_path = environment.shell_path
        self._runtime = runtime

    @override
    async def __call__(self, params: MonitorParams) -> ToolReturnValue:
        if self._runtime.role != "root":
            return ToolError(
                message="Background tasks can only be managed by the root agent.",
                brief="Background task unavailable",
            )
        if self._runtime.session.state.plan_mode:
            return ToolError(
                message="Monitor is not available in plan mode.",
                brief="Blocked in plan mode",
            )

        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            return ToolError(
                message="Monitor must be invoked as a tool call.",
                brief="No tool call context",
            )

        result = await self._approval.request(
            self.name,
            "start monitor",
            f"Monitor `{params.command}`",
        )
        if not result:
            return result.rejection_error()

        timeout_s = None if params.persistent else max(1, params.timeout_ms // 1000)
        view = self._runtime.background_tasks.create_monitor_task(
            command=params.command,
            description=params.description,
            timeout_s=timeout_s,
            tool_call_id=tool_call.id,
            shell_name="bash",
            shell_path=str(self._shell_path),
            cwd=str(self._runtime.session.work_dir),
            payload=MonitorPayload(),
        )
        display = BackgroundTaskDisplayBlock(
            task_id=view.spec.id,
            kind=view.spec.kind,
            status=view.runtime.status,
            description=view.spec.description,
        )
        return ToolReturnValue(
            is_error=False,
            output=(
                f"Monitor started.\ntask_id: {view.spec.id}\n"
                f"persistent: {str(params.persistent).lower()}\n"
                "Each matching stdout line will arrive as a notification. "
                "Stop with TaskStop."
            ),
            message="Monitor started.",
            display=[display],
        )
