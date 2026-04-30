from collections import deque
from pathlib import Path
from typing import override

from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field, model_validator

from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.file.utils import MEDIA_SNIFF_BYTES, detect_file_type
from kimi_cli.tools.utils import load_desc, truncate_line
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import is_within_workspace
from kimi_cli.utils.sensitive import is_sensitive_file

MAX_LINES = 1000
MAX_LINE_LENGTH = 2000
MAX_BYTES = 100 << 10  # 100KB


class Params(BaseModel):
    path: str = Field(
        description=(
            "The path to the file to read. Absolute paths are required when reading files "
            "outside the working directory."
        )
    )
    line_offset: int = Field(
        description=(
            "The line number to start reading from. "
            "By default read from the beginning of the file. "
            "Set this when the file is too large to read at once. "
            "Negative values read from the end of the file (e.g. -100 reads the last 100 lines). "
            f"The absolute value of negative offset cannot exceed {MAX_LINES}."
        ),
        default=1,
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

    @model_validator(mode="after")
    def _validate_line_offset(self) -> "Params":
        if self.line_offset == 0:
            raise ValueError(
                "line_offset cannot be 0; use 1 for the first line or -1 for the last line"
            )
        if self.line_offset < -MAX_LINES:
            raise ValueError(
                f"line_offset cannot be less than -{MAX_LINES}. "
                "Use a positive line_offset with the total line count "
                "to read from a specific position."
            )
        return self


class ReadFile(CallableTool2[Params]):
    name: str = "ReadFile"
    strict: bool = True
    params: type[Params] = Params

    def __init__(self, runtime: Runtime) -> None:
        description = load_desc(
            Path(__file__).parent / "read.md",
            {
                "MAX_LINES": MAX_LINES,
                "MAX_LINE_LENGTH": MAX_LINE_LENGTH,
                "MAX_BYTES": MAX_BYTES,
            },
        )
        super().__init__(description=description)
        self._runtime = runtime
        self._work_dir = runtime.builtin_args.KIMI_WORK_DIR
        self._additional_dirs = runtime.additional_dirs

    async def _validate_path(self, path: KaosPath) -> ToolError | None:
        """Validate that the path is safe to read."""
        resolved_path = path.canonical()

        if (
            not is_within_workspace(resolved_path, self._work_dir, self._additional_dirs)
            and not path.is_absolute()
        ):
            # Outside files can only be read with absolute paths
            return ToolError(
                message=(
                    f"`{path}` is not an absolute path. "
                    "You must provide an absolute path to read a file "
                    "outside the working directory."
                ),
                brief="Invalid path",
            )
        return None

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        if not params.path:
            return ToolError(
                message="File path cannot be empty.",
                brief="Empty file path",
            )

        try:
            p = KaosPath(params.path).expanduser()
            if err := await self._validate_path(p):
                return err
            p = p.canonical()

            if is_sensitive_file(str(p)):
                return ToolError(
                    message=(
                        f"`{params.path}` appears to contain secrets "
                        "(matched sensitive file pattern). "
                        "Reading this file is blocked to protect credentials."
                    ),
                    brief="Sensitive file",
                )

            if not await p.exists():
                return ToolError(
                    message=f"`{params.path}` does not exist.",
                    brief="File not found",
                )
            if not await p.is_file():
                return ToolError(
                    message=f"`{params.path}` is not a file.",
                    brief="Invalid path",
                )

            header = await p.read_bytes(MEDIA_SNIFF_BYTES)
            file_type = detect_file_type(str(p), header=header)
            if file_type.kind in ("image", "video"):
                return ToolError(
                    message=(
                        f"`{params.path}` is a {file_type.kind} file. "
                        "Use other appropriate tools to read image or video files."
                    ),
                    brief="Unsupported file type",
                )

            if file_type.kind == "unknown":
                return ToolError(
                    message=(
                        f"`{params.path}` seems not readable. "
                        "You may need to read it with proper shell commands, Python tools "
                        "or MCP tools if available. "
                        "If you read/operate it with Python, you MUST ensure that any "
                        "third-party packages are installed in a virtual environment (venv)."
                    ),
                    brief="File not readable",
                )

            assert params.n_lines >= 1
            assert params.line_offset != 0

            if params.line_offset < 0:
                return await self._read_tail(p, params)
            else:
                return await self._read_forward(p, params)
        except Exception as e:
            logger.warning("ReadFile failed: {path}: {error}", path=params.path, error=e)
            return ToolError(
                message=f"Failed to read {params.path}. Error: {e}",
                brief="Failed to read file",
            )

    async def _read_forward(self, p: KaosPath, params: Params) -> ToolReturnValue:
        """Read file from a positive line_offset, counting total lines."""
        lines: list[str] = []
        n_bytes = 0
        truncated_line_numbers: list[int] = []
        max_lines_reached = False
        max_bytes_reached = False
        collecting = True  # False once we've collected enough lines
        current_line_no = 0
        async for line in p.read_lines(errors="replace"):
            current_line_no += 1
            if not collecting:
                continue
            if current_line_no < params.line_offset:
                continue
            truncated = truncate_line(line, MAX_LINE_LENGTH)
            if truncated != line:
                truncated_line_numbers.append(current_line_no)
            lines.append(truncated)
            n_bytes += len(truncated.encode("utf-8"))
            if len(lines) >= params.n_lines:
                collecting = False
            elif len(lines) >= MAX_LINES:
                max_lines_reached = True
                collecting = False
            elif n_bytes >= MAX_BYTES:
                max_bytes_reached = True
                collecting = False

        total_lines = current_line_no

        # Format output with line numbers like `cat -n`
        start_line = params.line_offset
        lines_with_no: list[str] = []
        for line_num, line in zip(range(start_line, start_line + len(lines)), lines, strict=True):
            lines_with_no.append(f"{line_num:6d}\t{line}")

        message = (
            f"{len(lines)} lines read from file starting from line {start_line}."
            if len(lines) > 0
            else "No lines read from file."
        )
        message += f" Total lines in file: {total_lines}."
        if max_lines_reached:
            message += f" Max {MAX_LINES} lines reached."
        elif max_bytes_reached:
            message += f" Max {MAX_BYTES} bytes reached."
        elif len(lines) < params.n_lines:
            message += " End of file reached."
        if truncated_line_numbers:
            message += f" Lines {truncated_line_numbers} were truncated."
        return ToolOk(
            output="".join(lines_with_no),
            message=message,
        )

    async def _read_tail(self, p: KaosPath, params: Params) -> ToolReturnValue:
        """Read file from a negative line_offset (tail mode)."""
        tail_count = abs(params.line_offset)

        # Use a deque to keep the last `tail_count` lines with their line numbers
        # Each entry: (line_no, truncated_line, was_truncated)
        tail_buf: deque[tuple[int, str, bool]] = deque(maxlen=tail_count)
        current_line_no = 0
        async for line in p.read_lines(errors="replace"):
            current_line_no += 1
            truncated = truncate_line(line, MAX_LINE_LENGTH)
            tail_buf.append((current_line_no, truncated, truncated != line))

        total_lines = current_line_no

        # Step 1: Apply n_lines / MAX_LINES from head of tail_buf.
        # This preserves the user's requested start position.
        all_entries = list(tail_buf)
        line_limit = min(params.n_lines, MAX_LINES)
        candidates = all_entries[:line_limit]
        max_lines_reached = len(all_entries) > MAX_LINES and len(candidates) == MAX_LINES

        # Step 2: Apply MAX_BYTES — if candidates exceed the byte budget,
        # reverse-scan to keep the newest (closest to EOF) lines that fit.
        total_candidate_bytes = sum(len(entry[1].encode("utf-8")) for entry in candidates)
        if total_candidate_bytes > MAX_BYTES:
            max_bytes_reached = True
            kept = 0
            n_bytes = 0
            for entry in reversed(candidates):
                n_bytes += len(entry[1].encode("utf-8"))
                if n_bytes > MAX_BYTES:
                    break
                kept += 1
            candidates = candidates[len(candidates) - kept :]
        else:
            max_bytes_reached = False

        # Step 3: Collect results from candidates
        lines: list[str] = []
        line_numbers: list[int] = []
        truncated_line_numbers: list[int] = []

        for line_no, truncated, was_truncated in candidates:
            if was_truncated:
                truncated_line_numbers.append(line_no)
            lines.append(truncated)
            line_numbers.append(line_no)

        # Format output with absolute line numbers
        lines_with_no: list[str] = []
        for line_num, line in zip(line_numbers, lines, strict=True):
            lines_with_no.append(f"{line_num:6d}\t{line}")

        start_line = line_numbers[0] if line_numbers else total_lines + 1
        message = (
            f"{len(lines)} lines read from file starting from line {start_line}."
            if len(lines) > 0
            else "No lines read from file."
        )
        message += f" Total lines in file: {total_lines}."
        if max_lines_reached:
            message += f" Max {MAX_LINES} lines reached."
        elif max_bytes_reached:
            message += f" Max {MAX_BYTES} bytes reached."
        elif len(lines) < params.n_lines:
            message += " End of file reached."
        if truncated_line_numbers:
            message += f" Lines {truncated_line_numbers} were truncated."
        return ToolOk(
            output="".join(lines_with_no),
            message=message,
        )
