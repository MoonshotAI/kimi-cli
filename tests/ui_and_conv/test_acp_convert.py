import tempfile
from pathlib import Path
from typing import cast

import acp

from kimi_cli.acp.convert import acp_blocks_to_content_parts, tool_result_to_acp_content
from kimi_cli.acp.types import ACPContentBlock
from kimi_cli.wire.types import DiffDisplayBlock, TextPart, ToolReturnValue


def test_tool_result_to_acp_content_handles_diff_display():
    tool_ret = ToolReturnValue(
        is_error=False,
        output="",
        message="",
        display=[DiffDisplayBlock(path="foo.txt", old_text="before", new_text="after")],
    )

    contents = tool_result_to_acp_content(tool_ret)

    assert len(contents) == 1
    content = contents[0]
    assert isinstance(content, acp.schema.FileEditToolCallContent)
    assert content.type == "diff"
    assert content.path == "foo.txt"
    assert content.old_text == "before"
    assert content.new_text == "after"


def test_acp_blocks_to_content_parts_handles_text_block():
    blocks = [acp.schema.TextContentBlock(type="text", text="Hello, world!")]

    result = acp_blocks_to_content_parts(cast(list[ACPContentBlock], blocks))

    assert len(result) == 1
    assert isinstance(result[0], TextPart)
    assert result[0].text == "Hello, world!"


def test_acp_blocks_to_content_parts_handles_resource_block():
    """ResourceContentBlock should be logged but not converted to content."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("File content here")
        temp_path = f.name

    try:
        uri = f"file://{temp_path}"
        blocks = [acp.schema.ResourceContentBlock(type="resource_link", uri=uri, name="test.txt")]

        result = acp_blocks_to_content_parts(cast(list[ACPContentBlock], blocks))

        assert len(result) == 0
    finally:
        Path(temp_path).unlink()


def test_acp_blocks_to_content_parts_handles_embedded_resource_block():
    resource = acp.schema.TextResourceContents(
        uri="file:///path/to/file.txt", text="Embedded content", mime_type="text/plain"
    )
    blocks = [acp.schema.EmbeddedResourceContentBlock(type="resource", resource=resource)]

    result = acp_blocks_to_content_parts(cast(list[ACPContentBlock], blocks))

    assert len(result) == 1
    assert isinstance(result[0], TextPart)
    assert "file:///path/to/file.txt" in result[0].text
    assert "Embedded content" in result[0].text


def test_acp_blocks_to_content_parts_handles_nonexistent_file():
    """ResourceContentBlock with nonexistent file should be logged but not converted."""
    blocks = [
        acp.schema.ResourceContentBlock(
            type="resource_link", uri="file:///nonexistent/file.txt", name="missing.txt"
        )
    ]

    result = acp_blocks_to_content_parts(cast(list[ACPContentBlock], blocks))

    assert len(result) == 0


def test_acp_blocks_to_content_parts_handles_invalid_uri_scheme():
    """ResourceContentBlock with non-file URI should be logged but not converted."""
    blocks = [
        acp.schema.ResourceContentBlock(
            type="resource_link", uri="http://example.com/file.txt", name="remote.txt"
        )
    ]

    result = acp_blocks_to_content_parts(cast(list[ACPContentBlock], blocks))

    assert len(result) == 0


def test_acp_blocks_to_content_parts_handles_mixed_blocks():
    """Mixed blocks should handle text and embedded resources, but skip resource links."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("Test file")
        temp_path = f.name

    try:
        blocks = [
            acp.schema.TextContentBlock(type="text", text="Text block"),
            acp.schema.ResourceContentBlock(
                type="resource_link", uri=f"file://{temp_path}", name="test.txt"
            ),
        ]

        result = acp_blocks_to_content_parts(cast(list[ACPContentBlock], blocks))

        assert len(result) == 1
        assert isinstance(result[0], TextPart)
        assert result[0].text == "Text block"
    finally:
        Path(temp_path).unlink()
