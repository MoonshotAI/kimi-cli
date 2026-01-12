import base64
from pathlib import Path
from typing import override

from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.file.utils import MEDIA_SNIFF_BYTES, FileType, detect_file_type
from kimi_cli.tools.utils import load_desc_jinja, truncate_line
from kimi_cli.utils.path import is_within_directory
from kimi_cli.wire.types import ImageURLPart, VideoURLPart

MAX_LINES = 1000
MAX_LINE_LENGTH = 2000
MAX_BYTES = 100 << 10  # 100KB
MAX_MEDIA_BYTES = 80 << 20  # 80MB


def _to_data_url(mime_type: str, data: bytes) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


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
    params: type[Params] = Params

    def __init__(self, runtime: Runtime) -> None:
        capabilities = runtime.llm.capabilities if runtime.llm else set[str]()
        description = load_desc_jinja(
            Path(__file__).parent / "read.md",
            {
                "MAX_LINES": MAX_LINES,
                "MAX_LINE_LENGTH": MAX_LINE_LENGTH,
                "MAX_BYTES": MAX_BYTES,
                "MAX_MEDIA_BYTES": MAX_MEDIA_BYTES,
                "capabilities": capabilities,
            },
        )
        super().__init__(description=description)
        self._work_dir = runtime.builtin_args.KIMI_WORK_DIR

    async def _validate_path(self, path: KaosPath) -> ToolError | None:
        """Validate that the path is safe to read."""
        # Check for path traversal attempts
        resolved_path = path.canonical()

        if not is_within_directory(resolved_path, self._work_dir) and not path.is_absolute():
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

    async def _read_media(self, path: KaosPath, file_type: FileType) -> ToolReturnValue:
        assert file_type.kind in ("image", "video")

        stat = await path.stat()
        size = stat.st_size
        if size == 0:
            return ToolError(
                message=f"`{path}` is empty.",
                brief="Empty file",
            )
        if size > MAX_MEDIA_BYTES:
            return ToolError(
                message=(
                    f"`{path}` is {size} bytes, which exceeds the max "
                    f"{MAX_MEDIA_BYTES} bytes for media files."
                ),
                brief="File too large",
            )

        data = await path.read_bytes()
        data_url = _to_data_url(file_type.mime_type, data)
        match file_type.kind:
            case "image":
                part = ImageURLPart(image_url=ImageURLPart.ImageURL(url=data_url))
            case "video":
                part = VideoURLPart(video_url=VideoURLPart.VideoURL(url=data_url))
        return ToolOk(
            output=part,
            message=(
                f"Loaded {file_type.kind} file `{path}` ({file_type.mime_type}, {size} bytes)."
            ),
        )

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        # TODO: checks:
        # - check if the path may contain secrets

        if not params.path:
            return ToolError(
                message="File path cannot be empty.",
                brief="Empty file path",
            )

        try:
            p = KaosPath(params.path).expanduser()

            if err := await self._validate_path(p):
                return err

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
                return await self._read_media(p, file_type)

            if file_type.kind == "unknown":
                return ToolError(
                    message=(
                        f"`{params.path}` seems not readable as text. "
                        "ReadFile only supports text, image, and video files. "
                        "You may need to read it with proper shell commands, Python tools "
                        "or MCP tools if available. "
                        "If you read/operate it with Python, you MUST ensure that any "
                        "third-party packages are installed in a virtual environment (venv)."
                    ),
                    brief="File not readable",
                )

            assert params.line_offset >= 1
            assert params.n_lines >= 1

            lines: list[str] = []
            n_bytes = 0
            truncated_line_numbers: list[int] = []
            max_lines_reached = False
            max_bytes_reached = False
            current_line_no = 0
            async for line in p.read_lines(errors="replace"):
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
            lines_with_no: list[str] = []
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
