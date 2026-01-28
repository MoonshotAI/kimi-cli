"""Tests for the ReadMediaFile tool."""

from __future__ import annotations

from io import BytesIO
from typing import cast

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.llm import ModelCapability
from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.file.read_media import Params, ReadMediaFile
from kimi_cli.wire.types import ImageURLPart, TextPart, VideoURLPart


async def test_read_image_file(read_media_file_tool: ReadMediaFile, temp_work_dir: KaosPath):
    """Test reading an image file."""
    image_file = temp_work_dir / "sample.png"
    data = b"\x89PNG\r\n\x1a\n" + b"pngdata"
    await image_file.write_bytes(data)

    result = await read_media_file_tool(Params(path=str(image_file)))

    assert not result.is_error
    assert isinstance(result.output, list)
    assert len(result.output) == 3
    assert result.output[0] == TextPart(text=f'<image path="{image_file}">')
    assert result.output[2] == TextPart(text="</image>")
    part = result.output[1]
    assert isinstance(part, ImageURLPart)
    assert part.image_url.url.startswith("data:image/png;base64,")
    assert result.message == snapshot(
        f"Loaded image file `{image_file}` (image/png, {len(data)} bytes). "
        "If you need to output coordinates, output relative coordinates first and "
        "compute absolute coordinates using the original image size; if you generate or "
        "edit images/videos via commands or scripts, read the result back immediately "
        "before continuing."
    )


async def test_read_extensionless_image_file(
    read_media_file_tool: ReadMediaFile, temp_work_dir: KaosPath
):
    """Test reading an extensionless image file."""
    image_file = temp_work_dir / "sample"
    data = b"\x89PNG\r\n\x1a\n" + b"pngdata"
    await image_file.write_bytes(data)

    result = await read_media_file_tool(Params(path=str(image_file)))

    assert not result.is_error
    assert isinstance(result.output, list)
    assert len(result.output) == 3
    assert result.output[0] == TextPart(text=f'<image path="{image_file}">')
    assert result.output[2] == TextPart(text="</image>")
    part = result.output[1]
    assert isinstance(part, ImageURLPart)
    assert part.image_url.url.startswith("data:image/png;base64,")
    assert result.message == snapshot(
        f"Loaded image file `{image_file}` (image/png, {len(data)} bytes). "
        "If you need to output coordinates, output relative coordinates first and "
        "compute absolute coordinates using the original image size; if you generate or "
        "edit images/videos via commands or scripts, read the result back immediately "
        "before continuing."
    )


async def test_read_image_file_with_size(
    read_media_file_tool: ReadMediaFile, temp_work_dir: KaosPath
):
    """Test reading an image file with detectable dimensions."""
    Image = pytest.importorskip("PIL.Image")
    image_file = temp_work_dir / "valid.png"
    image = Image.new("RGB", (3, 4), color=(0, 0, 0))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    data = buffer.getvalue()
    await image_file.write_bytes(data)

    result = await read_media_file_tool(Params(path=str(image_file)))

    assert not result.is_error
    assert result.message == snapshot(
        f"Loaded image file `{image_file}` (image/png, {len(data)} bytes, original size 3x4px). "
        "If you need to output coordinates, output relative coordinates first and "
        "compute absolute coordinates using the original image size; if you generate or "
        "edit images/videos via commands or scripts, read the result back immediately "
        "before continuing."
    )


async def test_read_video_file(read_media_file_tool: ReadMediaFile, temp_work_dir: KaosPath):
    """Test reading a video file."""
    video_file = temp_work_dir / "sample.mp4"
    data = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    await video_file.write_bytes(data)

    result = await read_media_file_tool(Params(path=str(video_file)))

    assert not result.is_error
    assert isinstance(result.output, list)
    assert len(result.output) == 3
    assert result.output[0] == TextPart(text=f'<video path="{video_file}">')
    assert result.output[2] == TextPart(text="</video>")
    part = result.output[1]
    assert isinstance(part, VideoURLPart)
    assert part.video_url.url.startswith("data:video/mp4;base64,")
    assert result.message == snapshot(
        f"Loaded video file `{video_file}` (video/mp4, {len(data)} bytes). "
        "If you need to output coordinates, output relative coordinates first and "
        "compute absolute coordinates using the original image size; if you generate or "
        "edit images/videos via commands or scripts, read the result back immediately "
        "before continuing."
    )


async def test_read_text_file(read_media_file_tool: ReadMediaFile, temp_work_dir: KaosPath):
    """Test reading a text file with ReadMediaFile."""
    text_file = temp_work_dir / "sample.txt"
    await text_file.write_text("hello")

    result = await read_media_file_tool(Params(path=str(text_file)))

    assert result.is_error
    assert result.message == snapshot(
        f"`{text_file}` is a text file. Use ReadFile to read text files."
    )
    assert result.brief == snapshot("Unsupported file type")


async def test_read_video_file_without_capability(runtime: Runtime, temp_work_dir: KaosPath):
    """Test reading a video file without video capability."""
    assert runtime.llm is not None
    runtime.llm.capabilities = cast(set[ModelCapability], {"image_in"})
    read_media_file_tool = ReadMediaFile(runtime)

    video_file = temp_work_dir / "sample.mp4"
    data = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    await video_file.write_bytes(data)

    result = await read_media_file_tool(Params(path=str(video_file)))

    assert result.is_error
    assert result.message == snapshot(
        "The current model does not support video input. "
        "Tell the user to use a model with video input capability."
    )
    assert result.brief == snapshot("Unsupported media type")
