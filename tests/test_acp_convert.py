import acp

from gitrekt_cli.acp.convert import tool_result_to_acp_content
from gitrekt_cli.wire.types import DiffDisplayBlock, ToolReturnValue


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
