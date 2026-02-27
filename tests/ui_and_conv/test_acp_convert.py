import acp

from kimi_cli.acp.convert import acp_blocks_to_content_parts, tool_result_to_acp_content
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


def test_acp_blocks_to_content_parts_handles_embedded_text_resource():
    block = acp.schema.EmbeddedResourceContentBlock(
        type="resource",
        resource=acp.schema.TextResourceContents(
            uri="file:///path/to/foo.py",
            text="print('hello')",
        ),
    )
    parts = acp_blocks_to_content_parts([block])
    assert len(parts) == 1
    assert isinstance(parts[0], TextPart)
    assert "file:///path/to/foo.py" in parts[0].text
    assert "print('hello')" in parts[0].text


def test_acp_blocks_to_content_parts_handles_resource_link():
    block = acp.schema.ResourceContentBlock(
        type="resource_link",
        uri="file:///path/to/bar.py",
        name="bar.py",
    )
    parts = acp_blocks_to_content_parts([block])
    assert len(parts) == 1
    assert isinstance(parts[0], TextPart)
    assert "file:///path/to/bar.py" in parts[0].text
    assert "bar.py" in parts[0].text


def test_acp_blocks_to_content_parts_skips_blob_resource():
    block = acp.schema.EmbeddedResourceContentBlock(
        type="resource",
        resource=acp.schema.BlobResourceContents(
            uri="file:///path/to/image.png",
            blob="iVBORw0KGgo=",
        ),
    )
    parts = acp_blocks_to_content_parts([block])
    assert len(parts) == 0


def test_acp_blocks_to_content_parts_mixed_blocks():
    blocks = [
        acp.schema.TextContentBlock(type="text", text="Check this file:"),
        acp.schema.EmbeddedResourceContentBlock(
            type="resource",
            resource=acp.schema.TextResourceContents(
                uri="file:///src/main.py",
                text="def main(): pass",
            ),
        ),
    ]
    parts = acp_blocks_to_content_parts(blocks)
    assert len(parts) == 2
    assert isinstance(parts[0], TextPart)
    assert parts[0].text == "Check this file:"
    assert isinstance(parts[1], TextPart)
    assert "def main(): pass" in parts[1].text
