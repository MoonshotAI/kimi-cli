import asyncio
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
from kimi_cli.tools.utils import ToolResultBuilder, load_desc, record_pending_edit
from kimi_cli.utils.environment import Environment
from kimi_cli.utils.logging import logger
from kimi_cli.utils.subprocess_env import get_noninteractive_env

MAX_FOREGROUND_TIMEOUT = 5 * 60
MAX_BACKGROUND_TIMEOUT = 24 * 60 * 60


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

    @staticmethod
    def _is_readonly_safe_command(command: str) -> bool:
        """判断 Shell 命令在只读模式下是否安全（不会修改文件系统）。

        采用保守策略：只放行明确已知的只读命令，其余一律视为危险。
        """
        stripped = command.strip().lower()

        # 1. 基础危险符号：重定向
        if ">" in stripped or ">>" in stripped:
            return False

        # 2. 管道写入
        if "| tee" in stripped:
            return False

        # 3. 常见文件操作命令
        dangerous_prefixes = (
            "rm ", "mv ", "cp ", "chmod ", "chown ", "mkdir ", "rmdir ",
            "touch ", "mkfifo ", "ln ", "dd ", "truncate ",
        )
        if stripped.startswith(dangerous_prefixes):
            return False

        # 4. git 危险操作
        dangerous_git = (
            "git push", "git commit", "git merge", "git rebase",
            "git reset", "git cherry-pick", "git stash", "git clean",
            "git checkout -b", "git checkout --", "git revert",
        )
        for dg in dangerous_git:
            if dg in stripped:
                return False

        # 5. sed 原地编辑
        if "sed " in stripped and " -i" in stripped:
            return False

        # 6. 安装/构建/包管理命令
        install_prefixes = (
            "pip install", "pip uninstall", "npm install", "npm uninstall",
            "npm ci", "npm publish", "yarn add", "yarn remove", "pnpm install",
            "cargo build", "cargo install", "make ", "cmake ", "g++ ", "gcc ",
        )
        if stripped.startswith(install_prefixes):
            return False

        # 7. PowerShell / .NET 文件写入 API（绕过检测的常见方式）
        dotnet_file_ops = (
            "writealltext", "writealllines", "writeallbytes",
            "appendalltext", "appendalllines",
            "file.create", "file.delete", "file.move", "file.copy",
            "file.replace", "file.setattributes",
            "directory.create", "directory.delete", "directory.move",
            "streamwriter", "filestream", "binarywriter",
        )
        for pattern in dotnet_file_ops:
            if pattern in stripped:
                return False

        # 8. PowerShell Cmdlet 文件操作
        ps_file_ops = (
            "set-content", "add-content", "out-file", "new-item",
            "remove-item", "rename-item", "copy-item", "move-item",
            "clear-content", "export-csv", "export-clixml",
        )
        for pattern in ps_file_ops:
            if pattern in stripped:
                return False

        # 9. Python 文件写入（通过 -c 参数）
        if any(x in stripped for x in ("python -c", "python3 -c", "py -c")):
            py_write_patterns = (
                "open(", "os.remove", "os.rename", "os.mkdir", "os.rmdir",
                "os.makedirs", "shutil.copy", "shutil.move", "shutil.rmtree",
                "pathlib.", "file.write", ".write(",
            )
            for pattern in py_write_patterns:
                if pattern in stripped:
                    return False

        # 10. Node.js / JavaScript 文件写入（通过 -e 参数）
        if "node -e" in stripped or "node -p" in stripped or "node --eval" in stripped:
            return False

        # 11. 其他脚本解释器调用（一律视为危险，无法判断其内部行为）
        script_exec = (
            "bash -c", "sh -c", "zsh -c", "pwsh -c", "cmd /c",
            "php ", "ruby ", "perl ", "lua ", "tcl ", "awk -f", "gawk -f",
        )
        if stripped.startswith(script_exec):
            return False

        # 12. 网络下载命令（可能写入文件）
        download_cmds = (
            "curl -o", "curl --output", "wget -o", "wget --output-document",
            "invoke-webrequest", "start-bitstransfer",
        )
        for pattern in download_cmds:
            if pattern in stripped:
                return False

        return True

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        builder = ToolResultBuilder()

        if not params.command:
            return builder.error("Command cannot be empty.", brief="Empty command")

        # Readonly mode: block dangerous shell commands, allow read-only ones
        if getattr(self._runtime, "readonly", False):
            # Background tasks are always blocked in readonly mode
            if params.run_in_background:
                record_pending_edit(
                    self._runtime,
                    tool_name=self.name,
                    params={
                        "command": params.command,
                        "timeout": params.timeout,
                        "run_in_background": True,
                        "description": params.description,
                    },
                    description=f"后台执行 Shell 命令 `{params.command[:80]}{'...' if len(params.command) > 80 else ''}`",
                )
                pending_count = len(self._runtime.session.state.pending_edits)
                return builder.error(
                    f"当前处于只读模式，后台 Shell 命令被禁用。"
                    f"该操作已暂存到待修改清单（共 {pending_count} 项）。"
                    f"发送 /pending 查看清单，发送 /execute 批量执行所有暂存操作。",
                    brief="Readonly mode active",
                )

            # Foreground commands: allow read-only safe commands
            if not self._is_readonly_safe_command(params.command):
                record_pending_edit(
                    self._runtime,
                    tool_name=self.name,
                    params={
                        "command": params.command,
                        "timeout": params.timeout,
                        "run_in_background": False,
                        "description": params.description,
                    },
                    description=f"执行 Shell 命令 `{params.command[:80]}{'...' if len(params.command) > 80 else ''}`",
                )
                pending_count = len(self._runtime.session.state.pending_edits)
                return builder.error(
                    f"当前处于只读模式，该 Shell 命令可能修改文件系统，已被拦截。"
                    f"该操作已暂存到待修改清单（共 {pending_count} 项）。"
                    f"发送 /pending 查看清单，发送 /execute 批量执行所有暂存操作。",
                    brief="Readonly mode active",
                )
            # Safe command → proceed normally below

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
