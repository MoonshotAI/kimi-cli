import acp
from kosong.tooling import DisplayBlock, ToolReturnValue

from kimi_cli.acp.convert import tool_result_to_acp_content


def test_tool_result_to_acp_content_handles_diff_display():
    tool_ret = ToolReturnValue(
        is_error=False,
        output="",
        message="",
        display=[
            DisplayBlock(
                type="diff",
                data={"path": "foo.txt", "old_text": "before", "new_text": "after"},
            )
        ],
    )

    contents = tool_result_to_acp_content(tool_ret)

    assert len(contents) == 1
    content = contents[0]
    assert isinstance(content, acp.schema.FileEditToolCallContent)
    assert content.type == "diff"
    assert content.path == "foo.txt"
    assert content.old_text == "before"
    assert content.new_text == "after"
