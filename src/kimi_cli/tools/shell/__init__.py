import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import override

import kaos
from kosong.tooling import CallableTool2, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.approval import Approval
from kimi_cli.tools.utils import ToolRejectedError, ToolResultBuilder, load_desc
from kimi_cli.utils.environment import Environment

MAX_TIMEOUT = 5 * 60


class Params(BaseModel):
    command: str = Field(description="The bash command to execute.")
    timeout: int = Field(
        description=(
            "The timeout in seconds for the command to execute. "
            "If the command takes longer than this, it will be killed."
        ),
        default=60,
        ge=1,
        le=MAX_TIMEOUT,
    )


class Shell(CallableTool2[Params]):
    name: str = "Shell"
    params: type[Params] = Params

    def __init__(self, approval: Approval, environment: Environment):
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

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        builder = ToolResultBuilder()

        if not await self._approval.request(
            self.name,
            "run shell command",
            f"Run command `{params.command}`",
        ):
            return ToolRejectedError()

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

    async def _run_shell_command(
        self,
        command: str,
        stdout_cb: Callable[[bytes], None],
        stderr_cb: Callable[[bytes], None],
        timeout: int,
    ) -> int:
        async def _read_stream(stream: asyncio.StreamReader, cb: Callable[[bytes], None]):
            while True:
                line = await stream.readline()
                if line:
                    cb(line)
                else:
                    break

        process = await kaos.exec(*self._shell_args(command))

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _read_stream(process.stdout, stdout_cb),
                    _read_stream(process.stderr, stderr_cb),
                ),
                timeout,
            )
            return await process.wait()
        except TimeoutError:
            await process.kill()
            raise

    def _shell_args(self, command: str) -> tuple[str, ...]:
        if self._is_powershell:
            return (str(self._shell_path), "-command", command)
        return (str(self._shell_path), "-c", command)
