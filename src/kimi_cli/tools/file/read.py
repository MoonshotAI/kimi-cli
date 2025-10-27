from pathlib import Path
from typing import override

import aiofiles
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.soul.runtime import BuiltinSystemPromptArgs
from kimi_cli.tools.utils import load_desc, truncate_line

MAX_LINES = 1000
MAX_LINE_LENGTH = 2000
MAX_BYTES = 100 << 10  # 100KB


class Params(BaseModel):
    path: str = Field(description="The absolute path to the file to read")
    line_offset: int = Field(
        description=(
            "The line number to start reading from. "
            "By default read from the beginning of the file. "
            "Set this when the file is too large to read at once."
        ),
        default=1,
        ge=1,
    )
    n_lines: int = Field(
        description=(
            "The number of lines to read. "
            f"By default read up to {MAX_LINES} lines, which is the max allowed value. "
            "Set this value when the file is too large to read at once."
        ),
        default=MAX_LINES,
        ge=1,
    )


class ReadFile(CallableTool2[Params]):
    name: str = "ReadFile"
    description: str = load_desc(
        Path(__file__).parent / "read.md",
        {
            "MAX_LINES": str(MAX_LINES),
            "MAX_LINE_LENGTH": str(MAX_LINE_LENGTH),
            "MAX_BYTES": str(MAX_BYTES),
        },
    )
    params: type[Params] = Params

    def __init__(self, builtin_args: BuiltinSystemPromptArgs, **kwargs):
        super().__init__(**kwargs)
        self._work_dir = builtin_args.KIMI_WORK_DIR

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        # TODO: checks:
        # - check if the path may contain secrets
        # - check if the file format is readable
        try:
            p = Path(params.path)

            if not p.is_absolute():
                return ToolError(
                    message=(
                        f"`{params.path}` is not an absolute path. "
                        "You must provide an absolute path to read a file."
                    ),
                    brief="Invalid path",
                )

            if not p.exists():
                return ToolError(
                    message=f"`{params.path}` does not exist.",
                    brief="File not found",
                )
            if not p.is_file():
                return ToolError(
                    message=f"`{params.path}` is not a file.",
                    brief="Invalid path",
                )

            assert params.line_offset >= 1
            assert params.n_lines >= 1

            lines: list[str] = []
            n_bytes = 0
            truncated_line_numbers = []
            max_lines_reached = False
            max_bytes_reached = False
            async with aiofiles.open(p, encoding="utf-8", errors="replace") as f:
                current_line_no = 0
                async for line in f:
                    current_line_no += 1
                    if current_line_no < params.line_offset:
                        continue
                    truncated = truncate_line(line, MAX_LINE_LENGTH)
                    if truncated != line:
                        truncated_line_numbers.append(current_line_no)
                    lines.append(truncated)
                    n_bytes += len(truncated.encode("utf-8"))
                    if len(lines) >= params.n_lines:
                        break
                    if len(lines) >= MAX_LINES:
                        max_lines_reached = True
                        break
                    if n_bytes >= MAX_BYTES:
                        max_bytes_reached = True
                        break

            # Format output with line numbers like `cat -n`
            lines_with_no = []
            for line_num, line in zip(
                range(params.line_offset, params.line_offset + len(lines)), lines, strict=True
            ):
                # Use 6-digit line number width, right-aligned, with tab separator
                lines_with_no.append(f"{line_num:6d}\t{line}")

            message = (
                f"{len(lines)} lines read from file starting from line {params.line_offset}."
                if len(lines) > 0
                else "No lines read from file."
            )
            if max_lines_reached:
                message += f" Max {MAX_LINES} lines reached."
            elif max_bytes_reached:
                message += f" Max {MAX_BYTES} bytes reached."
            elif len(lines) < params.n_lines:
                message += " End of file reached."
            if truncated_line_numbers:
                message += f" Lines {truncated_line_numbers} were truncated."
            return ToolOk(
                output="".join(lines_with_no),  # lines already contain \n, just join them
                message=message,
            )
        except Exception as e:
            return ToolError(
                message=f"Failed to read {params.path}. Error: {e}",
                brief="Failed to read file",
            )
