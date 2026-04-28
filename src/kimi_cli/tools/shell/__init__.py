import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any
from typing import Self, override

import kaos
from kaos import AsyncReadable
from kosong.tooling import CallableTool2, ToolReturnValue
from pydantic import BaseModel, Field, model_validator

from kimi_cli.background import TaskView, format_task
from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.display import BackgroundTaskDisplayBlock, ShellDisplayBlock
from kimi_cli.tools.utils import ToolResultBuilder, load_desc
from kimi_cli.utils.environment import Environment
from kimi_cli.utils.logging import logger
from kimi_cli.utils.subprocess_env import get_noninteractive_env

MAX_FOREGROUND_TIMEOUT = 5 * 60
MAX_BACKGROUND_TIMEOUT = 24 * 60 * 60
TIMEOUT_ALIAS_FIELD = "timeout_s"
UNSUPPORTED_TIMEOUT_FIELDS = frozenset({"timeout_ms", "timeoutSeconds"})


class Params(BaseModel):
    command: str = Field(description="The command to execute.")
    timeout: int = Field(
        description=(
            "The timeout in seconds for the command to execute. "
            "If the command takes longer than this, it will be killed."
        ),
        default=60,
        ge=1,
        le=MAX_BACKGROUND_TIMEOUT,
    )
    run_in_background: bool = Field(
        default=False,
        description="Whether to run the command as a background task.",
    )
    description: str = Field(
        default="",
        description=(
            "A short description for the background task. Required when run_in_background=true."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_timeout_fields(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        values = dict(data)

        unsupported = sorted(k for k in UNSUPPORTED_TIMEOUT_FIELDS if k in values)
        if unsupported:
            raise ValueError(
                f"Unsupported timeout field(s): {', '.join(unsupported)}. "
                f"Use `timeout` or `{TIMEOUT_ALIAS_FIELD}` in seconds."
            )

        has_timeout = "timeout" in values
        has_timeout_alias = TIMEOUT_ALIAS_FIELD in values
        if has_timeout and has_timeout_alias and values["timeout"] != values[TIMEOUT_ALIAS_FIELD]:
            raise ValueError("`timeout` and `timeout_s` must match when both are provided")
        if not has_timeout and has_timeout_alias:
            values["timeout"] = values[TIMEOUT_ALIAS_FIELD]

        return values

    @model_validator(mode="after")
    def _validate_background_fields(self) -> Self:
        if self.run_in_background and not self.description.strip():
            raise ValueError("description is required when run_in_background is true")
        if not self.run_in_background and self.timeout > MAX_FOREGROUND_TIMEOUT:
            raise ValueError(
                f"timeout must be <= {MAX_FOREGROUND_TIMEOUT}s for foreground commands; "
                f"use run_in_background=true for longer timeouts (up to {MAX_BACKGROUND_TIMEOUT}s)"
            )
        return self


class Shell(CallableTool2[Params]):
    name: str = "Shell"
    params: type[Params] = Params

    def __init__(self, approval: Approval, environment: Environment, runtime: Runtime):
        is_powershell = environment.shell_name == "Windows PowerShell"
        super().__init__(
            description=load_desc(
                Path(__file__).parent / ("powershell.md" if is_powershell else "bash.md"),
                {"SHELL": f"{environment.shell_name} (`{environment.shell_path}`)"},
            )
        )
        self._approval = approval
        self._is_powershell = is_powershell
        self._shell_path = environment.shell_path
        self._runtime = runtime

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        builder = ToolResultBuilder()

        if not params.command:
            return builder.error("Command cannot be empty.", brief="Empty command")

        if params.run_in_background:
            return await self._run_in_background(params)

        result = await self._approval.request(
            self.name,
            "run command",
            f"Run command `{params.command}`",
            display=[
                ShellDisplayBlock(
                    language="powershell" if self._is_powershell else "bash",
                    command=params.command,
                )
            ],
        )
        if not result:
            return result.rejection_error()

        def stdout_cb(line: bytes):
            line_str = line.decode(encoding="utf-8", errors="replace")
            builder.write(line_str)

        def stderr_cb(line: bytes):
            line_str = line.decode(encoding="utf-8", errors="replace")
            builder.write(line_str)

        try:
            exitcode = await self._run_shell_command(
                params.command, stdout_cb, stderr_cb, params.timeout
            )

            if exitcode == 0:
                return builder.ok("Command executed successfully.")
            else:
                return builder.error(
                    f"Command failed with exit code: {exitcode}.",
                    brief=f"Failed with exit code: {exitcode}",
                )
        except TimeoutError:
            return builder.error(
                f"Command killed by timeout ({params.timeout}s)",
                brief=f"Killed by timeout ({params.timeout}s)",
            )
        except Exception as e:
            logger.error(
                "Shell command execution failed: {command}: {error}",
                command=params.command,
                error=e,
            )
            return builder.error(
                f"Command execution failed: {e}",
                brief="Execution failed",
            )

    async def _run_in_background(self, params: Params) -> ToolReturnValue:
        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            return ToolResultBuilder().error(
                "Background shell requires a tool call context.",
                brief="No tool call context",
            )

        result = await self._approval.request(
            self.name,
            "run background command",
            f"Run background command `{params.command}`",
            display=[
                ShellDisplayBlock(
                    language="powershell" if self._is_powershell else "bash",
                    command=params.command,
                )
            ],
        )
        if not result:
            return result.rejection_error()

        try:
            view = self._runtime.background_tasks.create_bash_task(
                command=params.command,
                description=params.description.strip(),
                timeout_s=params.timeout,
                tool_call_id=tool_call.id,
                shell_name="Windows PowerShell" if self._is_powershell else "bash",
                shell_path=str(self._shell_path),
                cwd=str(self._runtime.session.work_dir),
            )
        except Exception as exc:
            logger.error(
                "Failed to start background shell task: {command}: {error}",
                command=params.command,
                error=exc,
            )
            builder = ToolResultBuilder()
            return builder.error(f"Failed to start background task: {exc}", brief="Start failed")

        return self._background_ok(view)

    def _background_ok(self, view: TaskView) -> ToolReturnValue:
        builder = ToolResultBuilder()
        builder.write(
            "\n".join(
                [
                    format_task(view, include_command=True),
                    "automatic_notification: true",
                    "next_step: You will be automatically notified when it completes.",
                    (
                        "next_step: Use TaskOutput with this task_id for a non-blocking "
                        "status/output snapshot. Only set block=true when you intentionally "
                        "want to wait."
                    ),
                    "next_step: Use TaskStop only if the task must be cancelled.",
                    (
                        "human_shell_hint: For users in the interactive shell, "
                        "the only task-management slash command is /task. "
                        "Do not suggest /task list, /task output, /task stop, or /tasks."
                    ),
                ]
            )
        )
        builder.display(
            BackgroundTaskDisplayBlock(
                task_id=view.spec.id,
                kind=view.spec.kind,
                status=view.runtime.status,
                description=view.spec.description,
            )
        )
        return builder.ok("Background task started", brief=f"Started {view.spec.id}")

    async def _run_shell_command(
        self,
        command: str,
        stdout_cb: Callable[[bytes], None],
        stderr_cb: Callable[[bytes], None],
        timeout: int,
    ) -> int:
        async def _read_stream(stream: AsyncReadable, cb: Callable[[bytes], None]):
            while True:
                line = await stream.readline()
                if line:
                    cb(line)
                else:
                    break

        process = await kaos.exec(*self._shell_args(command), env=get_noninteractive_env())

        # Close stdin immediately so interactive prompts (e.g. git password) get
        # EOF instead of hanging forever waiting for input that will never come.
        process.stdin.close()

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _read_stream(process.stdout, stdout_cb),
                    _read_stream(process.stderr, stderr_cb),
                ),
                timeout,
            )
            return await process.wait()
        except asyncio.CancelledError:
            await process.kill()
            raise
        except TimeoutError:
            await process.kill()
            raise

    def _shell_args(self, command: str) -> tuple[str, ...]:
        if self._is_powershell:
            return (str(self._shell_path), "-command", command)
        return (str(self._shell_path), "-c", command)
