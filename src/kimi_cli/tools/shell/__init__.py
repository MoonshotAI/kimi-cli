import asyncio
import re
from collections.abc import Callable
from pathlib import Path
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
from kimi_cli.utils.shell_quoting import rewrite_windows_null_redirect
from kimi_cli.utils.subprocess_env import get_noninteractive_env

MAX_FOREGROUND_TIMEOUT = 5 * 60
MAX_BACKGROUND_TIMEOUT = 24 * 60 * 60
DEFAULT_TIMEOUT = 60

LONG_RUNNING_COMMAND_TIMEOUTS: tuple[tuple[re.Pattern[str], int], ...] = (
    (re.compile(r"\bgit\s+submodule\s+(?:deinit|update|sync)\b", re.I), 300),
    (re.compile(r"\bgit\s+(?:clone|fetch)\b", re.I), 300),
    (re.compile(r"\bgit\s+show\b.*\s--\s", re.I), 120),
    (re.compile(r"\b(?:npm|yarn|pnpm)\s+(?:install|ci|run\s+build|build)\b", re.I), 180),
    (re.compile(r"\b(?:docker|cargo)\s+build\b", re.I), 300),
    (re.compile(r"\bmake(?:\s+-j\d*)?(?:\s|$)", re.I), 300),
)


def _effective_timeout(command: str, timeout: int, *, max_timeout: int) -> int:
    normalized = " ".join(command.split())
    for pattern, suggested_timeout in LONG_RUNNING_COMMAND_TIMEOUTS:
        if pattern.search(normalized):
            return min(max(timeout, suggested_timeout), max_timeout)
    return timeout


class Params(BaseModel):
    command: str = Field(description="The command to execute.")
    timeout: int = Field(
        description=(
            "The timeout in seconds for the command to execute. "
            "If the command takes longer than this, it will be killed."
        ),
        default=DEFAULT_TIMEOUT,
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
        super().__init__(
            description=load_desc(
                Path(__file__).parent / "bash.md",
                {"SHELL": f"{environment.shell_name} (`{environment.shell_path}`)"},
            )
        )
        self._approval = approval
        self._shell_path = environment.shell_path
        self._on_windows = environment.os_kind == "Windows"
        self._runtime = runtime

    def _preprocess_command(self, command: str) -> str:
        """Apply platform-specific defensive rewrites before execution."""
        return rewrite_windows_null_redirect(command, on_windows=self._on_windows)

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        builder = ToolResultBuilder()

        if not params.command:
            return builder.error("Command cannot be empty.", brief="Empty command")

        if params.run_in_background:
            return await self._run_in_background(params)

        command = self._preprocess_command(params.command)
        timeout = _effective_timeout(
            command, params.timeout, max_timeout=MAX_FOREGROUND_TIMEOUT
        )

        result = await self._approval.request(
            self.name,
            "run command",
            f"Run command `{command}`",
            display=[
                ShellDisplayBlock(
                    language="bash",
                    command=command,
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
            exitcode = await self._run_shell_command(command, stdout_cb, stderr_cb, timeout)

            if exitcode == 0:
                return builder.ok("Command executed successfully.")
            else:
                brief = f"Failed with exit code: {exitcode}"
                tail = builder.tail()
                if tail:
                    brief += f"\n{tail}"
                return builder.error(
                    f"Command failed with exit code: {exitcode}.",
                    brief=brief,
                )
        except TimeoutError:
            return builder.error(
                f"Command killed by timeout ({timeout}s)",
                brief=f"Killed by timeout ({timeout}s)",
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

        command = self._preprocess_command(params.command)

        result = await self._approval.request(
            self.name,
            "run background command",
            f"Run background command `{command}`",
            display=[
                ShellDisplayBlock(
                    language="bash",
                    command=command,
                )
            ],
        )
        if not result:
            return result.rejection_error()

        try:
            timeout = _effective_timeout(
                command, params.timeout, max_timeout=MAX_BACKGROUND_TIMEOUT
            )
            view = self._runtime.background_tasks.create_bash_task(
                command=command,
                description=params.description.strip(),
                timeout_s=timeout,
                tool_call_id=tool_call.id,
                shell_name="bash",
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

        env = get_noninteractive_env()
        # Override SHELL so commands that read $SHELL see the bash we're actually
        # running, not an empty/stale value inherited from the parent (most visible
        # on Windows, where the parent's SHELL is typically empty or PowerShell).
        env["SHELL"] = str(self._shell_path)
        process = await kaos.exec(*self._shell_args(command), env=env)

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
        return (str(self._shell_path), "-c", command)
