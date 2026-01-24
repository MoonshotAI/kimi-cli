import base64
from io import BytesIO
from pathlib import Path
from typing import override

from kaos.path import KaosPath
from kosong.chat_provider.kimi import Kimi
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Runtime
from kimi_cli.tools import SkipThisTool
from kimi_cli.tools.file.utils import MEDIA_SNIFF_BYTES, FileType, detect_file_type
from kimi_cli.tools.utils import load_desc_jinja
from kimi_cli.utils.path import is_within_directory
from kimi_cli.wire.types import ImageURLPart, VideoURLPart

MAX_MEDIA_MEGABYTES = 100


def _to_data_url(mime_type: str, data: bytes) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_image_size(data: bytes) -> tuple[int, int] | None:
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        with Image.open(BytesIO(data)) as image:
            image.load()
            return image.size
    except Exception:
        return None


class Params(BaseModel):
    path: str = Field(
        description=(
            "The path to the file to read. Absolute paths are required when reading files "
            "outside the working directory."
        )
    )


class ReadMediaFile(CallableTool2[Params]):
    name: str = "ReadMediaFile"
    params: type[Params] = Params

    def __init__(self, runtime: Runtime) -> None:
        capabilities = runtime.llm.capabilities if runtime.llm else set[str]()
        if "image_in" not in capabilities and "video_in" not in capabilities:
            raise SkipThisTool()

        description = load_desc_jinja(
            Path(__file__).parent / "read_media.md",
            {
                "MAX_MEDIA_MEGABYTES": MAX_MEDIA_MEGABYTES,
                "capabilities": capabilities,
            },
        )
        super().__init__(description=description)

        self._runtime = runtime
        self._work_dir = runtime.builtin_args.KIMI_WORK_DIR
        self._capabilities = capabilities

    async def _validate_path(self, path: KaosPath) -> ToolError | None:
        """Validate that the path is safe to read."""
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

        media_id = str(path)
        stat = await path.stat()
        size = stat.st_size
        if size == 0:
            return ToolError(
                message=f"`{path}` is empty.",
                brief="Empty file",
            )
        if size > (MAX_MEDIA_MEGABYTES << 20):
            return ToolError(
                message=(
                    f"`{path}` is {size} bytes, which exceeds the max "
                    f"{MAX_MEDIA_MEGABYTES}MB bytes for media files."
                ),
                brief="File too large",
            )

        match file_type.kind:
            case "image":
                data = await path.read_bytes()
                data_url = _to_data_url(file_type.mime_type, data)
                part = ImageURLPart(image_url=ImageURLPart.ImageURL(url=data_url, id=media_id))
                image_size = _extract_image_size(data)
            case "video":
                data = await path.read_bytes()
                if (llm := self._runtime.llm) and isinstance(llm.chat_provider, Kimi):
                    part = await llm.chat_provider.files.upload_video(
                        data=data,
                        mime_type=file_type.mime_type,
                    )
                    part.video_url.id = media_id
                else:
                    data_url = _to_data_url(file_type.mime_type, data)
                    part = VideoURLPart(video_url=VideoURLPart.VideoURL(url=data_url, id=media_id))
                image_size = None

        size_hint = ""
        if image_size:
            size_hint = f", original size {image_size[0]}x{image_size[1]}px"
        note = (
            " If you need to output coordinates, output relative coordinates first and "
            "compute absolute coordinates using the original image size; if you generate or "
            "edit images/videos via commands or scripts, read the result back immediately "
            "before continuing."
        )
        return ToolOk(
            output=part,
            message=(
                f"Loaded {file_type.kind} file `{path}` "
                f"({file_type.mime_type}, {size} bytes{size_hint}).{note}"
            ),
        )

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
            if file_type.kind == "text":
                return ToolError(
                    message=f"`{params.path}` is a text file. Use ReadFile to read text files.",
                    brief="Unsupported file type",
                )
            if file_type.kind == "unknown":
                return ToolError(
                    message=(
                        f"`{params.path}` seems not readable as an image or video file. "
                        "You may need to read it with proper shell commands, Python tools "
                        "or MCP tools if available. "
                        "If you read/operate it with Python, you MUST ensure that any "
                        "third-party packages are installed in a virtual environment (venv)."
                    ),
                    brief="File not readable",
                )

            if file_type.kind == "image" and "image_in" not in self._capabilities:
                return ToolError(
                    message=(
                        "The current model does not support image input. "
                        "Tell the user to use a model with image input capability."
                    ),
                    brief="Unsupported media type",
                )
            if file_type.kind == "video" and "video_in" not in self._capabilities:
                return ToolError(
                    message=(
                        "The current model does not support video input. "
                        "Tell the user to use a model with video input capability."
                    ),
                    brief="Unsupported media type",
                )

            return await self._read_media(p, file_type)
        except Exception as e:
            return ToolError(
                message=f"Failed to read {params.path}. Error: {e}",
                brief="Failed to read file",
            )
