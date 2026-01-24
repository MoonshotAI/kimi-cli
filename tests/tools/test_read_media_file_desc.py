from __future__ import annotations

from typing import cast

# ruff: noqa

import pytest
from inline_snapshot import snapshot

from kimi_cli.llm import ModelCapability
from kimi_cli.soul.agent import Runtime
from kimi_cli.tools import SkipThisTool
from kimi_cli.tools.file.read_media import ReadMediaFile


@pytest.mark.parametrize(
    ("capabilities", "expected"),
    [
        (
            {"image_in", "video_in"},
            snapshot(
                """\
Read media content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.
- The media content will be returned in a form that you can directly view and understand.

**Capabilities**
- This tool supports image and video files for the current model.
"""
            ),
        ),
        (
            {"image_in"},
            snapshot(
                """\
Read media content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.
- The media content will be returned in a form that you can directly view and understand.

**Capabilities**
- This tool supports image files for the current model.
- Video files are not supported by the current model.
"""
            ),
        ),
        (
            {"video_in"},
            snapshot(
                """\
Read media content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.
- The media content will be returned in a form that you can directly view and understand.

**Capabilities**
- This tool supports video files for the current model.
- Image files are not supported by the current model.
"""
            ),
        ),
    ],
)
def test_read_media_file_description_by_capabilities(
    runtime: Runtime, capabilities: set[str], expected: str
) -> None:
    assert runtime.llm is not None
    runtime.llm.capabilities = cast(set[ModelCapability], capabilities)
    assert ReadMediaFile(runtime).base.description == expected


def test_read_media_file_description_without_capabilities(runtime: Runtime) -> None:
    assert runtime.llm is not None
    runtime.llm.capabilities = cast(set[ModelCapability], set())
    with pytest.raises(SkipThisTool):
        ReadMediaFile(runtime)
