from inline_snapshot import snapshot

from kosong.message import ImageURLPart, TextPart
from kosong.tooling import (
    BriefDisplayBlock,
    ToolError,
    ToolOk,
    ToolReturnValue,
    UnknownDisplayBlock,
)
from kosong.tooling.error import ToolNotFoundError


def test_tool_return_value():
    ret = ToolReturnValue(
        is_error=False,
        output=[
            TextPart(type="text", text="output text"),
            ImageURLPart(
                type="image_url",
                image_url=ImageURLPart.ImageURL(url="https://example.com/image.png"),
            ),
        ],
        message="This is a successful tool call.",
        display=[
            BriefDisplayBlock(text="a brief msg for user"),
        ],
        extras={"key1": "value1", "key2": 42},
    )
    dump = ret.model_dump(mode="json", exclude_none=True)
    assert dump == snapshot(
        {
            "is_error": False,
            "output": [
                {"type": "text", "text": "output text"},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png"},
                },
            ],
            "message": "This is a successful tool call.",
            "display": [{"type": "brief", "text": "a brief msg for user"}],
            "extras": {"key1": "value1", "key2": 42},
        }
    )

    assert ToolReturnValue.model_validate(dump) == ret


def test_tool_ok():
    ret = ToolOk(
        output="output text",
        message="This is a successful tool call.",
        brief="a brief msg for user",
    )
    assert isinstance(ret, ToolReturnValue)
    assert ret.model_dump(mode="json", exclude_none=True) == snapshot(
        {
            "is_error": False,
            "output": "output text",
            "message": "This is a successful tool call.",
            "display": [{"type": "brief", "text": "a brief msg for user"}],
        }
    )


def test_tool_error():
    ret = ToolError(
        message="This is a failed tool call.",
        brief="a brief error msg for user",
        output="error output text",
    )
    assert isinstance(ret, ToolReturnValue)
    assert ret.model_dump(mode="json", exclude_none=True) == snapshot(
        {
            "is_error": True,
            "output": "error output text",
            "message": "This is a failed tool call.",
            "display": [{"type": "brief", "text": "a brief error msg for user"}],
        }
    )


def test_tool_ok_with_content_parts():
    ret = ToolOk(
        output=[
            TextPart(type="text", text="output text"),
            ImageURLPart(
                type="image_url",
                image_url=ImageURLPart.ImageURL(url="https://example.com/image.png"),
            ),
        ],
        message="This is a successful tool call.",
        brief="a brief msg for user",
    )
    assert isinstance(ret, ToolReturnValue)
    assert ret.model_dump(mode="json", exclude_none=True) == snapshot(
        {
            "is_error": False,
            "output": [
                {"type": "text", "text": "output text"},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png"},
                },
            ],
            "message": "This is a successful tool call.",
            "display": [{"type": "brief", "text": "a brief msg for user"}],
        }
    )


def test_tool_error_subclass():
    ret = ToolNotFoundError(tool_name="non_existent_tool")
    assert isinstance(ret, ToolReturnValue)
    assert isinstance(ret, ToolError)
    assert ret.model_dump(mode="json", exclude_none=True) == snapshot(
        {
            "is_error": True,
            "output": "",
            "message": "Tool `non_existent_tool` not found",
            "display": [{"type": "brief", "text": "Tool `non_existent_tool` not found"}],
        }
    )


def test_unknown_display_block():
    payload = {
        "is_error": False,
        "output": "ok",
        "message": "done",
        "display": [
            {"type": "fancy", "title": "Hello", "payload": {"a": 1}, "list": [1, 2]},
        ],
    }
    ret = ToolReturnValue.model_validate(payload)
    assert ret.display == snapshot(
        [
            UnknownDisplayBlock(
                type="fancy", data={"title": "Hello", "payload": {"a": 1}, "list": [1, 2]}
            )
        ]
    )
    assert ret.model_dump(mode="json", exclude_none=True) == snapshot(
        {
            "is_error": False,
            "output": "ok",
            "message": "done",
            "display": [
                {
                    "type": "fancy",
                    "data": {"title": "Hello", "payload": {"a": 1}, "list": [1, 2]},
                }
            ],
        }
    )
