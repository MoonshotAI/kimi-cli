import asyncio
import platform
from collections.abc import Callable
from pathlib import Path
from typing import Any, override

from kosong.tooling import CallableTool2, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.soul.approval import Approval
from kimi_cli.tools.utils import ToolRejectedError, ToolResultBuilder, load_desc

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


_NAME = "CMD" if platform.system() == "Windows" else "Bash"
_DESC_FILE = "cmd.md" if platform.system() == "Windows" else "bash.md"


class Bash(CallableTool2[Params]):
    name: str = _NAME
    description: str = load_desc(Path(__file__).parent / _DESC_FILE, {})
    params: type[Params] = Params

    def __init__(self, approval: Approval, **kwargs: Any):
        super().__init__(**kwargs)
        self._approval = approval

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
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
            exitcode = await _stream_subprocess(
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


async def _stream_subprocess(
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

    # FIXME: if the event loop is cancelled, an exception may be raised when the process finishes
    process = await asyncio.create_subprocess_shell(
        command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )

    assert process.stdout is not None, "stdout is None"
    assert process.stderr is not None, "stderr is None"

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
        process.kill()
        raise
