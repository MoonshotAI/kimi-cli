from __future__ import annotations
from typing import cast

# ruff: noqa

import pytest
from inline_snapshot import snapshot

from gitrekt_cli.llm import ModelCapability
from gitrekt_cli.soul.agent import Runtime
from gitrekt_cli.tools.file.read import ReadFile


@pytest.mark.parametrize(
    ("capabilities", "expected"),
    [
        (
            {"image_in", "video_in"},
            snapshot(
                """\
Read content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read text, image and video files. To list directories, you must use the Glob tool or `ls` command via the Shell tool. To read other file types, use appropriate commands via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.
- For text files:
  - Content will be returned with a line number before each line like `cat -n` format.
  - Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.
  - The maximum number of lines that can be read at once is 1000.
  - Any lines longer than 2000 characters will be truncated, ending with "...".
- For image and video files:
  - Content will be returned in a form that you can view and understand. Feel confident to read image/video files with this tool.
  - The maximum size that can be read is 83886080 bytes. An error will be returned if the file is larger than this limit.
"""
            ),
        ),
        (
            {"image_in"},
            snapshot(
                """\
Read content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read text, image and video files. To list directories, you must use the Glob tool or `ls` command via the Shell tool. To read other file types, use appropriate commands via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.
- For text files:
  - Content will be returned with a line number before each line like `cat -n` format.
  - Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.
  - The maximum number of lines that can be read at once is 1000.
  - Any lines longer than 2000 characters will be truncated, ending with "...".
- For image files:
  - Content will be returned in a form that you can view and understand. Feel confident to read image files with this tool.
  - The maximum size that can be read is 83886080 bytes. An error will be returned if the file is larger than this limit.
- Other media files (e.g., video, PDFs) are not supported by this tool. Use other proper tools to process them.
"""
            ),
        ),
        (
            {"video_in"},
            snapshot(
                """\
Read content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read text, image and video files. To list directories, you must use the Glob tool or `ls` command via the Shell tool. To read other file types, use appropriate commands via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.
- For text files:
  - Content will be returned with a line number before each line like `cat -n` format.
  - Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.
  - The maximum number of lines that can be read at once is 1000.
  - Any lines longer than 2000 characters will be truncated, ending with "...".
- For video files:
  - Content will be returned in a form that you can view and understand. Feel confident to read video files with this tool.
  - The maximum size that can be read is 83886080 bytes. An error will be returned if the file is larger than this limit.
- Other media files (e.g., image, PDFs) are not supported by this tool. Use other proper tools to process them.
"""
            ),
        ),
        (
            set(),
            snapshot(
                """\
Read content from a file.

**Tips:**
- Make sure you follow the description of each tool parameter.
- A `<system>` tag will be given before the read file content.
- The system will notify you when there is anything wrong when reading the file.
- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.
- This tool can only read text, image and video files. To list directories, you must use the Glob tool or `ls` command via the Shell tool. To read other file types, use appropriate commands via the Shell tool.
- If the file doesn't exist or path is invalid, an error will be returned.
- If you want to search for a certain content/pattern, prefer Grep tool over ReadFile.
- For text files:
  - Content will be returned with a line number before each line like `cat -n` format.
  - Use `line_offset` and `n_lines` parameters when you only need to read a part of the file.
  - The maximum number of lines that can be read at once is 1000.
  - Any lines longer than 2000 characters will be truncated, ending with "...".
- Media files (e.g., image, video, PDFs) are not supported by this tool. Use other proper tools to process them.
"""
            ),
        ),
    ],
)
def test_read_file_description_by_capabilities(
    runtime: Runtime, capabilities: set[str], expected: str
) -> None:
    assert runtime.llm is not None
    runtime.llm.capabilities = cast(set[ModelCapability], capabilities)
    assert ReadFile(runtime).base.description == expected
